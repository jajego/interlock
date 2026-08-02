import test from "node:test";
import assert from "node:assert/strict";
import {
  assertJsonValue,
  canonicalHash,
  canonicalJson,
  createInterlock,
  defineLifecycle,
  isInterlockError,
  incrementVersion,
  MAX_BIGINT_VERSION,
  parseVersionToken,
} from "../packages/core/dist/index.js";
import {
  normalizePostgresError,
  PostgresDriver,
} from "../packages/postgres/dist/index.js";

test("version tokens reject unsafe counters and increment PostgreSQL BIGINT values", () => {
  assert.equal(parseVersionToken("0").success, false);
  const parsed = parseVersionToken("9007199254740993");
  assert.equal(parsed.success, true);
  if (parsed.success)
    assert.equal(incrementVersion(parsed.value), "9007199254740994");
  assert.equal(
    parseVersionToken(String(MAX_BIGINT_VERSION + 1n)).success,
    false,
  );
  assert.throws(
    () => incrementVersion(String(MAX_BIGINT_VERSION)),
    (error) =>
      isInterlockError(error) && error.code === "INTERLOCK_VERSION_EXHAUSTED",
  );
});

test("canonical JSON ignores object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
});

test("JSON validation rejects cycles deterministically", () => {
  const value = {};
  value.self = value;
  assert.throws(() => assertJsonValue(value), /cyclic/);
});

test("definitions reject accidental self transitions", () => {
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["open"],
      history: { resourceType: "item" },
      events: {
        close: { from: ["open"], to: "open", mutate: () => ({}) },
      },
    }),
  );
});

test("definitions reject duplicate states and guard names", () => {
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["a", "a"],
      history: { resourceType: "item" },
      events: {},
    }),
  );
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["a", "b"],
      history: { resourceType: "item" },
      events: {
        move: {
          from: ["a"],
          to: "b",
          guards: [
            { name: "same", evaluate: () => ({ allowed: true }) },
            { name: "same", evaluate: () => ({ allowed: true }) },
          ],
          mutate: () => ({}),
        },
      },
    }),
  );
});

test("validated definitions are stable after caller mutation", () => {
  const definition = {
    name: "item",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: { move: { from: ["a"], to: "b", mutate: () => ({}) } },
  };
  const lifecycle = defineLifecycle()(definition);
  definition.events.move.to = "invalid";
  definition.events.other = definition.events.move;
  assert.equal(lifecycle.getEvent("move").to, "b");
  assert.equal(lifecycle.getEvent("other"), undefined);
  assert.ok(Object.isFrozen(lifecycle.getEvent("move").from));
});

test("validated definitions snapshot caller-owned input parsers", async () => {
  const schema = {
    parse: () => ({ success: true, value: "original" }),
  };
  const lifecycle = defineLifecycle()({
    name: "parser",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: {
      move: {
        from: ["a"],
        to: "b",
        input: schema,
        mutate: () => ({}),
      },
    },
  });
  schema.parse = () => ({ success: true, value: "mutated" });
  const parsed = await lifecycle.parseInput(lifecycle.getEvent("move"), {});
  assert.deepEqual(parsed, { success: true, value: "original" });
});

function executorFixture(options = {}) {
  const order = [];
  let inserted;
  const driver = {
    transaction: (operation, transactionOptions) => {
      options.observeTransactionOptions?.(transactionOptions);
      return operation({});
    },
    claimIdempotency: async (_transaction, claim) => {
      order.push("claim");
      return options.claim ?? { status: "claimed", claim };
    },
    completeIdempotency: async () => order.push("complete"),
    insertTransition: async (_transaction, value) => {
      order.push("history");
      inserted = value;
      return value;
    },
    insertOutbox: async () => order.push("outbox"),
  };
  const definition = {
    name: "item",
    states: ["a", "b"],
    history: {
      resourceType: "item",
      metadata: () => {
        order.push("metadata");
        return options.metadata ?? {};
      },
    },
    idempotency: { fingerprint: () => "fingerprint" },
    events: {
      move: {
        from: ["a"],
        to: "b",
        authorize: (args) => {
          order.push("authorize");
          return options.authorize?.(args) ?? { allowed: true };
        },
        guards: options.guards,
        mutate: (args) => {
          order.push("mutate");
          return options.mutate?.(args) ?? {};
        },
        outbox: options.outbox,
      },
    },
  };
  const binding = {
    transactionOptions: () => options.transactionOptions ?? {},
    loadPrimary: async () => ({
      id: options.loadedId ?? "item-1",
      state: "a",
      version: "1",
    }),
    getId: (resource) => resource.id,
    getState: (resource) => resource.state,
    getVersion: (resource) => resource.version,
    applyPrimary: async (_transaction, args) => {
      order.push("apply");
      return (
        options.applied ?? {
          status: "applied",
          resource: {
            ...args.resource,
            state: args.toState,
            version: args.nextVersion,
          },
        }
      );
    },
    contextFactory: { create: () => ({}) },
    consistency: () => ({ strategy: "none", notes: "fixture" }),
  };
  const clocks = [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:00:01.000Z"),
  ];
  const subject = createInterlock({
    lifecycle: defineLifecycle()(definition),
    driver,
    binding,
    now: () => {
      order.push("clock");
      return clocks.shift();
    },
    ids: options.ids ?? (() => "transition-1"),
  });
  return { subject, order, getTransition: () => inserted };
}

const transitionRequest = {
  id: "item-1",
  event: "move",
  actor: undefined,
  expectedVersion: "1",
  idempotency: { key: "key" },
};

test("transition clock is allocated after authoritative assessment", async () => {
  const fixture = executorFixture();
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.deepEqual(fixture.order.slice(0, 5), [
    "clock",
    "claim",
    "authorize",
    "clock",
    "mutate",
  ]);
  assert.equal(
    fixture.getTransition().occurredAt.toISOString(),
    "2026-01-01T00:00:01.000Z",
  );
});

test("history projections and serialization finish before application writes", async () => {
  const fixture = executorFixture();
  await fixture.subject.transition(transitionRequest);
  assert.ok(fixture.order.indexOf("metadata") < fixture.order.indexOf("apply"));
});

test("runtime boundaries return unknown-event and invalid-input", async () => {
  const fixture = executorFixture();
  assert.deepEqual(
    await fixture.subject.assess({
      id: "item-1",
      event: "missing",
      actor: undefined,
    }),
    { status: "unknown-event", event: "missing" },
  );
  const invalid = await fixture.subject.transition({
    ...transitionRequest,
    input: {},
  });
  assert.equal(invalid.status, "invalid-input");
});

test("empty idempotency keys are rejected before a transaction", async () => {
  const fixture = executorFixture();
  const result = await fixture.subject.transition({
    ...transitionRequest,
    idempotency: { key: "" },
  });
  assert.equal(result.status, "invalid-input");
  assert.equal(fixture.order.includes("claim"), false);
});

test("assess forces read-only transactions and strips private denial data", async () => {
  let transactionOptions;
  const fixture = executorFixture({
    transactionOptions: { isolation: "serializable", readOnly: false },
    observeTransactionOptions: (value) => {
      transactionOptions = value;
    },
    guards: [
      {
        name: "private",
        evaluate: () => ({
          allowed: false,
          denial: {
            code: "NO",
            publicMessage: "Not allowed",
            privateMessage: "secret",
            details: { secret: true },
          },
        }),
      },
    ],
  });
  const result = await fixture.subject.assess({
    id: "item-1",
    event: "move",
    actor: undefined,
  });
  assert.deepEqual(transactionOptions, {
    isolation: "serializable",
    readOnly: true,
  });
  assert.deepEqual(result.reasons, [
    {
      source: "guard",
      rule: "private",
      code: "NO",
      publicMessage: "Not allowed",
    },
  ]);
});

test("callbacks cannot mutate the loaded concurrency boundary", async () => {
  const fixture = executorFixture({
    mutate: ({ resource }) => {
      resource.state = "b";
      return {};
    },
  });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("outbox IDs are allocated before application writes", async () => {
  let calls = 0;
  const fixture = executorFixture({
    outbox: () => [{ topic: "item.moved", payload: {} }],
    ids: () => {
      calls += 1;
      if (calls === 2) throw new Error("id allocation failed");
      return "transition-1";
    },
  });
  await assert.rejects(fixture.subject.transition(transitionRequest));
  assert.equal(fixture.order.includes("apply"), false);
});

test("a binding cannot substitute another resource identity", async () => {
  const fixture = executorFixture({ loadedId: "other" });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("an applied resource must match the requested identity, state, and version", async () => {
  for (const resource of [
    { id: "other", state: "b", version: "2" },
    { id: "item-1", state: "a", version: "2" },
    { id: "item-1", state: "b", version: "1" },
  ]) {
    const fixture = executorFixture({
      applied: { status: "applied", resource },
    });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
    );
    assert.equal(fixture.order.includes("history"), false);
  }
});

test("cyclic outbox data fails with a typed error before writes", async () => {
  const payload = {};
  payload.self = payload;
  const fixture = executorFixture({
    outbox: () => [{ topic: "cyclic", payload }],
  });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_SERIALIZATION_FAILED",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("PostgreSQL operational codes remain distinct from domain conflicts", () => {
  assert.equal(
    normalizePostgresError({ code: "40001" }).code,
    "INTERLOCK_SERIALIZATION_CONFLICT",
  );
  assert.equal(
    normalizePostgresError({ code: "40P01" }).code,
    "INTERLOCK_DEADLOCK",
  );
  assert.equal(
    normalizePostgresError({ code: "55P03" }).code,
    "INTERLOCK_LOCK_TIMEOUT",
  );
  assert.equal(
    normalizePostgresError({ code: "57014" }).code,
    "INTERLOCK_CANCELLED",
  );
});

test("Interlock errors are recognizable across physical package copies", () => {
  const duplicateCopyError = Object.assign(new Error("failed"), {
    name: "InterlockError",
    code: "INTERLOCK_TRANSACTION_FAILED",
  });
  assert.equal(isInterlockError(duplicateCopyError), true);
});

test("connection loss during commit reports an unknown commit outcome", async () => {
  let releases = 0;
  const client = {
    on: () => undefined,
    off: () => undefined,
    query: async (sql) => {
      if (sql === "COMMIT")
        throw Object.assign(new Error("connection lost"), { code: "08006" });
      return { rowCount: 0, rows: [] };
    },
    release: () => {
      releases += 1;
    },
  };
  const driver = new PostgresDriver({ connect: async () => client });
  await assert.rejects(
    driver.transaction(async () => "done"),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_COMMIT_OUTCOME_UNKNOWN",
  );
  assert.equal(releases, 1);
});

test("connection acquisition failures are normalized", async () => {
  const failure = Object.assign(new Error("connection refused"), {
    code: "ECONNREFUSED",
  });
  const driver = new PostgresDriver({
    connect: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    driver.transaction(async () => "done"),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_TRANSACTION_FAILED" &&
      error.cause === failure,
  );
});

test("release failures do not replace transaction failures", async () => {
  const original = new Error("operation failed");
  const client = {
    on: () => undefined,
    off: () => undefined,
    query: async () => ({ rowCount: 0, rows: [] }),
    release: () => {
      throw new Error("release failed");
    },
  };
  const driver = new PostgresDriver({ connect: async () => client });
  await assert.rejects(
    driver.transaction(async () => {
      throw original;
    }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_TRANSACTION_FAILED" &&
      error.cause === original,
  );
});

test("rollback failure does not replace the original execution failure", async () => {
  const original = new Error("operation failed");
  const rollback = new Error("rollback failed");
  const client = {
    on: () => undefined,
    off: () => undefined,
    query: async (sql) => {
      if (sql === "ROLLBACK") throw rollback;
      return { rowCount: 0, rows: [] };
    },
    release: () => undefined,
  };
  const driver = new PostgresDriver({ connect: async () => client });
  await assert.rejects(
    driver.transaction(async () => {
      throw original;
    }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_TRANSACTION_FAILED" &&
      error.cause === original,
  );
});
