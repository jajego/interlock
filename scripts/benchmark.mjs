import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import { Pool } from "pg";
import {
  canonicalHash,
  createInterlock,
  defineLifecycle,
} from "../packages/core/dist/index.js";
import { snapshotJsonValue as productionSnapshot } from "../packages/core/dist/json.js";
import { PostgresDriver } from "../packages/postgres/dist/index.js";

const connectionString =
  process.env.BENCHMARK_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
assert.ok(
  connectionString,
  "BENCHMARK_DATABASE_URL or TEST_DATABASE_URL is required for pnpm benchmark",
);

const schema = "interlock_benchmark";
const warmups = positiveInteger("BENCHMARK_WARMUPS", 5);
const iterations = positiveInteger("BENCHMARK_ITERATIONS", 25);
const concurrencyIterations = positiveInteger(
  "BENCHMARK_CONCURRENCY_ITERATIONS",
  10,
);
const migration = await readFile(
  new URL("../packages/postgres/migrations/001_interlock.sql", import.meta.url),
  "utf8",
);

function positiveInteger(name, fallback) {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(
    Number.isInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
  return value;
}

function percentile(sorted, fraction) {
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function summarize(
  samples,
  successful,
  statements,
  queryClasses,
  operationsPerSample = 1,
) {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    warmups,
    iterations: samples.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    meanMs: total / samples.length,
    statementsPerTransition:
      statements / (samples.length * operationsPerSample),
    successfulTransitionsPerSecond: successful / (total / 1_000),
    queryClasses,
  };
}

function classify(sql) {
  const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.startsWith("begin")) return "transaction.begin";
  if (normalized === "commit") return "transaction.commit";
  if (normalized === "rollback") return "transaction.rollback";
  if (normalized.startsWith(`insert into "${schema}"."interlock_idempotency"`))
    return "idempotency.claim";
  if (normalized.startsWith("select i.fingerprint")) return "idempotency.read";
  if (normalized.startsWith(`update "${schema}"."interlock_idempotency"`))
    return "idempotency.complete";
  if (
    normalized.startsWith(
      `insert into "${schema}"."interlock_transition_history"`,
    )
  )
    return "history.insert";
  if (normalized.startsWith(`insert into "${schema}"."interlock_outbox"`))
    return "outbox.insert";
  if (normalized.startsWith("update benchmark_resources"))
    return "primary.update";
  if (
    normalized.startsWith("select") &&
    normalized.includes("benchmark_resources")
  )
    return normalized.includes("/* hydrate */")
      ? "primary.hydrate"
      : "primary.load";
  return "other";
}

function countingPool(pool) {
  const counts = new Map();
  let statements = 0;
  return {
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql, values) => {
            statements += 1;
            const name = classify(typeof sql === "string" ? sql : sql.text);
            counts.set(name, (counts.get(name) ?? 0) + 1);
            return target.query(sql, values);
          };
        },
      });
    },
    snapshot() {
      return {
        statements,
        classes: Object.fromEntries([...counts].sort()),
      };
    },
    reset() {
      statements = 0;
      counts.clear();
    },
  };
}

function payload(bytes) {
  const values = [];
  while (JSON.stringify({ values }).length + 515 < bytes)
    values.push({ index: values.length, value: "x".repeat(480) });
  const remaining = bytes - JSON.stringify({ values, tail: "" }).length;
  return { values, tail: "x".repeat(Math.max(0, remaining)) };
}

function lifecycleFor({
  guards = 0,
  outbox = 0,
  jsonBytes = 0,
  asyncProjections = false,
}) {
  const sharedPayload = payload(jsonBytes);
  return defineLifecycle()({
    name: `benchmark-${guards}-${outbox}-${jsonBytes}`,
    states: ["ready", "done"],
    history: { resourceType: "benchmark-resource" },
    idempotency: {
      fingerprint: ({ resourceId, event, expectedVersion }) =>
        canonicalHash({ resourceId, event, expectedVersion }),
    },
    events: {
      complete: {
        from: ["ready"],
        to: "done",
        guards: Array.from({ length: guards }, (_, index) => ({
          name: `guard-${index}`,
          evaluate: () => true,
        })),
        mutate: asyncProjections ? async () => ({}) : () => ({}),
        audit: jsonBytes ? () => sharedPayload : undefined,
        outbox: () =>
          Array.from({ length: outbox }, (_, index) => ({
            topic: "benchmark.completed",
            key: String(index),
            payload: sharedPayload,
          })),
      },
    },
  });
}

function subjectFor(pool, options) {
  const binding = {
    transactionOptions: () => ({ isolation: "read-committed" }),
    loadPrimary: async (transaction, operation) => {
      const result = await transaction.query(
        "SELECT id, state, version::text version FROM benchmark_resources WHERE id = $1",
        [operation.id],
      );
      return result.rows[0] ?? null;
    },
    getId: (resource) => resource.id,
    getState: (resource) => resource.state,
    getVersion: (resource) => resource.version,
    applyPrimary: async (transaction, args) => {
      const result = await transaction.query(
        `UPDATE benchmark_resources SET state = $2, version = $3
         WHERE id = $1 AND state = $4 AND version = $5
         RETURNING id, state, version::text version`,
        [
          args.resource.id,
          args.toState,
          args.nextVersion,
          args.fromState,
          args.expectedVersion,
        ],
      );
      return result.rows[0]
        ? { status: "applied", resource: result.rows[0] }
        : { status: "conflict" };
    },
    ...(options.hydrate
      ? {
          hydrateBeforeCommit: async (transaction, args) => {
            const result = await transaction.query(
              "SELECT /* hydrate */ id, state, version::text version FROM benchmark_resources WHERE id = $1",
              [args.resource.id],
            );
            return result.rows[0];
          },
        }
      : {}),
    contextFactory: { create: () => ({}) },
    consistency: () => ({ strategy: "none", notes: "Benchmark fixture." }),
  };
  return createInterlock({
    lifecycle: lifecycleFor(options),
    binding,
    driver: new PostgresDriver(pool, { schema }),
    maxOutboxPayloadBytes: Math.max(256_000, options.jsonBytes + 1_024),
  });
}

async function seed(pool, ids) {
  await pool.query(
    "INSERT INTO benchmark_resources (id, state, version) SELECT value, 'ready', 1 FROM unnest($1::text[]) value",
    [ids],
  );
}

function request(id, idempotent, key = id) {
  return {
    id,
    event: "complete",
    actor: undefined,
    expectedVersion: "1",
    ...(idempotent ? { idempotency: { key } } : {}),
  };
}

async function latencyScenario(setupPool, measuredPool, name, options) {
  const total = warmups + iterations;
  const ids = Array.from({ length: total }, () => randomUUID());
  await seed(setupPool, ids);
  const subject = subjectFor(measuredPool, options);
  for (let index = 0; index < warmups; index += 1)
    await subject.transition(request(ids[index], options.idempotent));
  measuredPool.reset();
  const samples = [];
  let successful = 0;
  for (let index = warmups; index < total; index += 1) {
    const started = performance.now();
    const result = await subject.transition(
      request(ids[index], options.idempotent),
    );
    samples.push(performance.now() - started);
    if (result.status === "committed") successful += 1;
  }
  const queries = measuredPool.snapshot();
  return {
    name,
    ...summarize(samples, successful, queries.statements, queries.classes),
  };
}

async function duplicateScenario(setupPool, measuredPool) {
  const id = randomUUID();
  const subject = subjectFor(measuredPool, {
    guards: 0,
    outbox: 0,
    jsonBytes: 0,
    idempotent: true,
  });
  await seed(setupPool, [id]);
  await subject.transition(request(id, true, "duplicate"));
  for (let index = 0; index < warmups; index += 1)
    await subject.transition(request(id, true, "duplicate"));
  measuredPool.reset();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await subject.transition(request(id, true, "duplicate"));
    samples.push(performance.now() - started);
    assert.equal(result.status, "committed");
    assert.equal(result.duplicate, true);
  }
  const queries = measuredPool.snapshot();
  return {
    name: "duplicate-idempotent-replay",
    ...summarize(samples, iterations, queries.statements, queries.classes),
  };
}

async function concurrencyScenario(setupPool, measuredPool, concurrency, kind) {
  const subject = subjectFor(measuredPool, {
    guards: 0,
    outbox: 0,
    jsonBytes: 0,
    idempotent: kind !== "conflict",
  });
  const setupSubject = subjectFor(setupPool, {
    guards: 0,
    outbox: 0,
    jsonBytes: 0,
    idempotent: true,
  });
  const samples = [];
  let successful = 0;
  const outcomes = {};
  const rounds = warmups + concurrencyIterations;
  for (let round = 0; round < rounds; round += 1) {
    const ids =
      kind === "conflict"
        ? Array(concurrency).fill(randomUUID())
        : Array.from({ length: concurrency }, () => randomUUID());
    await seed(setupPool, [...new Set(ids)]);
    const requests = ids.map((id, index) =>
      request(
        id,
        kind !== "conflict",
        kind === "duplicate" ? `key-${round}` : `key-${round}-${index}`,
      ),
    );
    if (kind === "duplicate") {
      await setupSubject.transition(request(ids[0], true, `key-${round}`));
      requests.fill(request(ids[0], true, `key-${round}`));
    }
    if (round === warmups) measuredPool.reset();
    const started = performance.now();
    const results = await Promise.all(
      requests.map((value) => subject.transition(value)),
    );
    const elapsed = performance.now() - started;
    if (round >= warmups) {
      samples.push(elapsed);
      for (const result of results) {
        outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
        if (
          result.status === "committed" &&
          (kind !== "duplicate" || result.duplicate)
        )
          successful += 1;
      }
    }
  }
  const queries = measuredPool.snapshot();
  return {
    name: `concurrency-${concurrency}-${kind}`,
    concurrency,
    outcomes,
    ...summarize(
      samples,
      successful,
      queries.statements,
      queries.classes,
      concurrency,
    ),
  };
}

function oldAssert(value, path = "$", ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))
  )
    throw new TypeError(`${path} is not JSON-safe`);
  if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
  ancestors.add(value);
  if (Array.isArray(value))
    value.forEach((item, index) =>
      oldAssert(item, `${path}[${index}]`, ancestors),
    );
  else
    for (const [key, item] of Object.entries(value))
      oldAssert(item, `${path}.${key}`, ancestors);
  ancestors.delete(value);
}

function oldClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(oldClone);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, oldClone(item)]),
  );
}

function oldSnapshot(value) {
  oldAssert(value);
  return oldClone(value);
}

function onePassSnapshot(value, path = "$", ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))
  )
    throw new TypeError(`${path} is not JSON-safe`);
  if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
  ancestors.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    const item = onePassSnapshot(
      value[key],
      Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`,
      ancestors,
    );
    if (key === "__proto__")
      Object.defineProperty(copy, key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else copy[key] = item;
  }
  ancestors.delete(value);
  return copy;
}

function jsonBenchmark() {
  return [1_024, 65_536, 262_144].flatMap((bytes) => {
    const value = payload(bytes);
    assert.deepEqual(productionSnapshot(value), onePassSnapshot(value));
    const runs = Math.max(20, Math.floor(2_000_000 / bytes));
    return [
      ["two-pass", oldSnapshot],
      ["one-pass-path-string", onePassSnapshot],
      ["one-pass-path-stack", productionSnapshot],
    ].map(([implementation, snapshot]) => {
      for (let index = 0; index < 5; index += 1) snapshot(value);
      const started = performance.now();
      for (let index = 0; index < runs; index += 1) snapshot(value);
      return {
        bytes,
        implementation,
        iterations: runs,
        meanMs: (performance.now() - started) / runs,
      };
    });
  });
}

if (process.env.BENCHMARK_JSON_ONLY === "true") {
  process.stdout.write(`${JSON.stringify(jsonBenchmark(), null, 2)}\n`);
  process.exit(0);
}

const admin = new Pool({ connectionString });
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.end();

const setupPool = new Pool({
  connectionString,
  options: `-c search_path=${schema},public`,
});
await setupPool.query(migration);
await setupPool.query(
  "CREATE TABLE benchmark_resources (id TEXT PRIMARY KEY, state TEXT NOT NULL, version BIGINT NOT NULL)",
);
const rawMeasuredPool = new Pool({
  connectionString,
  options: `-c search_path=${schema},public`,
  max: 60,
});
const measuredPool = countingPool(rawMeasuredPool);

const scenarios = [
  [
    "non-idempotent-no-outbox",
    { idempotent: false, outbox: 0, guards: 0, jsonBytes: 0 },
  ],
  [
    "first-idempotent-execution",
    { idempotent: true, outbox: 0, guards: 0, jsonBytes: 0 },
  ],
  [
    "synchronous-projections",
    { idempotent: false, outbox: 0, guards: 0, jsonBytes: 0 },
  ],
  [
    "asynchronous-projections",
    {
      idempotent: false,
      outbox: 0,
      guards: 0,
      jsonBytes: 0,
      asyncProjections: true,
    },
  ],
  ["outbox-1", { idempotent: false, outbox: 1, guards: 0, jsonBytes: 0 }],
  ["outbox-5", { idempotent: false, outbox: 5, guards: 0, jsonBytes: 0 }],
  ["outbox-20", { idempotent: false, outbox: 20, guards: 0, jsonBytes: 0 }],
  ["hydration-off", { idempotent: false, outbox: 0, guards: 0, jsonBytes: 0 }],
  [
    "hydration-on",
    { idempotent: false, outbox: 0, guards: 0, jsonBytes: 0, hydrate: true },
  ],
  ["guards-0", { idempotent: false, outbox: 0, guards: 0, jsonBytes: 0 }],
  ["guards-1", { idempotent: false, outbox: 0, guards: 1, jsonBytes: 0 }],
  ["guards-5", { idempotent: false, outbox: 0, guards: 5, jsonBytes: 0 }],
  ["json-1kb", { idempotent: false, outbox: 1, guards: 0, jsonBytes: 1_024 }],
  ["json-64kb", { idempotent: false, outbox: 1, guards: 0, jsonBytes: 65_536 }],
  [
    "json-256kb",
    { idempotent: false, outbox: 1, guards: 0, jsonBytes: 262_144 },
  ],
];

try {
  const latency = [];
  for (const [name, options] of scenarios)
    latency.push(await latencyScenario(setupPool, measuredPool, name, options));
  latency.splice(2, 0, await duplicateScenario(setupPool, measuredPool));
  const concurrency = [];
  for (const size of [1, 10, 50])
    for (const kind of ["first", "duplicate", "conflict"])
      concurrency.push(
        await concurrencyScenario(setupPool, measuredPool, size, kind),
      );
  const report = {
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      postgres: (await setupPool.query("SHOW server_version")).rows[0]
        .server_version,
      schema,
      warmups,
      iterations,
      concurrencyIterations,
    },
    latency,
    concurrency,
    jsonSnapshot: jsonBenchmark(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rawMeasuredPool.end();
  await setupPool.end();
}
