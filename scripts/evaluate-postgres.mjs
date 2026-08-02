import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import { Pool } from "pg";
import { PostgresDriver } from "../packages/postgres/dist/index.js";

const connectionString =
  process.env.BENCHMARK_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
assert.ok(
  connectionString,
  "BENCHMARK_DATABASE_URL or TEST_DATABASE_URL is required",
);
const schema = "interlock_performance_evaluation";
const migration = await readFile(
  new URL("../packages/postgres/migrations/001_interlock.sql", import.meta.url),
  "utf8",
);

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ];
  return {
    iterations: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
}

function artifact(id, occurredAt) {
  const transition = {
    id: `transition-${id}`,
    lifecycle: "artifact-evaluation",
    resourceType: "item",
    resourceId: id,
    event: "move",
    fromState: "a",
    toState: "b",
    previousVersion: "1",
    nextVersion: "2",
    idempotencyKey: `key-${id}`,
    requestFingerprint: "fingerprint",
    occurredAt,
  };
  return {
    transition,
    messages: Array.from({ length: 5 }, (_, index) => ({
      id: `outbox-${id}-${index}`,
      lifecycle: transition.lifecycle,
      resourceType: transition.resourceType,
      resourceId: id,
      transitionId: transition.id,
      topic: "item.moved",
      key: String(index),
      payload: { id, index },
      createdAt: occurredAt,
    })),
  };
}

const consolidatedSql = `WITH history AS (
  INSERT INTO interlock_transition_history
    (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,actor_type,actor_id,audit_data,metadata,correlation_id,causation_id,idempotency_key,request_fingerprint,definition_version,occurred_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
  RETURNING id
), outbox AS (
  INSERT INTO interlock_outbox
    (id,lifecycle,resource_type,resource_id,transition_id,topic,message_key,payload,created_at)
  SELECT message.id,message.lifecycle,message.resource_type,message.resource_id,message.transition_id,message.topic,message.message_key,message.payload,message.created_at
  FROM jsonb_to_recordset($20::jsonb) AS message(
    id text,lifecycle text,resource_type text,resource_id text,transition_id text,topic text,message_key text,payload jsonb,created_at timestamptz
  )
  JOIN history ON history.id = message.transition_id
  RETURNING id
), completion AS (
  UPDATE interlock_idempotency
  SET transition_id = $1, completed_at = $19
  WHERE lifecycle = $2 AND resource_id = $4 AND idempotency_key = $16 AND transition_id IS NULL
  RETURNING transition_id
)
SELECT
  (SELECT count(*)::int FROM history) history,
  (SELECT count(*)::int FROM outbox) outbox,
  (SELECT count(*)::int FROM completion) completion`;

async function measureArtifacts(pool, mode) {
  const driver = new PostgresDriver(pool);
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    const id = randomUUID();
    const occurredAt = new Date();
    const value = artifact(id, occurredAt);
    await pool.query(
      `INSERT INTO interlock_idempotency
       (lifecycle,resource_id,idempotency_key,fingerprint,created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        value.transition.lifecycle,
        id,
        value.transition.idempotencyKey,
        value.transition.requestFingerprint,
        occurredAt,
      ],
    );
    const started = performance.now();
    if (mode === "current")
      await driver.transaction(async (transaction) => {
        await driver.insertTransition(transaction, value.transition);
        await driver.insertOutbox(transaction, value.messages);
        await driver.completeIdempotency(transaction, {
          lifecycle: value.transition.lifecycle,
          resourceId: id,
          key: value.transition.idempotencyKey,
          transitionId: value.transition.id,
          completedAt: occurredAt,
        });
      });
    else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(consolidatedSql, [
          value.transition.id,
          value.transition.lifecycle,
          value.transition.resourceType,
          value.transition.resourceId,
          value.transition.event,
          value.transition.fromState,
          value.transition.toState,
          value.transition.previousVersion,
          value.transition.nextVersion,
          null,
          null,
          null,
          null,
          null,
          null,
          value.transition.idempotencyKey,
          value.transition.requestFingerprint,
          null,
          occurredAt,
          JSON.stringify(
            value.messages.map((message) => ({
              id: message.id,
              lifecycle: message.lifecycle,
              resource_type: message.resourceType,
              resource_id: message.resourceId,
              transition_id: message.transitionId,
              topic: message.topic,
              message_key: message.key,
              payload: message.payload,
              created_at: message.createdAt,
            })),
          ),
        ]);
        assert.deepEqual(result.rows[0], {
          history: 1,
          outbox: 5,
          completion: 1,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    if (index >= 5) samples.push(performance.now() - started);
  }
  return {
    mode,
    statementsPerTransaction: mode === "current" ? 5 : 3,
    ...summary(samples),
  };
}

function planSummary(result) {
  const document = result.rows[0]["QUERY PLAN"][0];
  const nodes = [];
  const visit = (node) => {
    nodes.push({
      node: node["Node Type"],
      index: node["Index Name"],
      rows: node["Actual Rows"],
      loops: node["Actual Loops"],
      hitBlocks: node["Shared Hit Blocks"],
      readBlocks: node["Shared Read Blocks"],
    });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(document.Plan);
  return {
    planningMs: document["Planning Time"],
    executionMs: document["Execution Time"],
    nodes,
  };
}

async function explain(pool, order) {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id,lifecycle,resource_id,next_version,occurred_at
     FROM interlock_transition_history
     WHERE lifecycle = 'history-evaluation' AND resource_id = 'resource-42'
     ORDER BY ${order} DESC LIMIT 50`,
  );
  return planSummary(result);
}

const admin = new Pool({ connectionString });
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.end();
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema},public`,
});

try {
  await pool.query(migration);
  const artifacts = [];
  for (let run = 1; run <= 3; run += 1) {
    artifacts.push({
      run,
      current: await measureArtifacts(pool, "current"),
      consolidated: await measureArtifacts(pool, "consolidated"),
    });
  }
  await pool.query(`INSERT INTO interlock_transition_history
    (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,occurred_at)
    SELECT
      'history-' || resource || '-' || version,
      'history-evaluation',
      'item',
      'resource-' || resource,
      'move','a','b',version,version + 1,
      timestamptz '2026-01-01' + (version || ' seconds')::interval
    FROM generate_series(1,100) resource
    CROSS JOIN generate_series(1,1000) version`);
  await pool.query("ANALYZE interlock_transition_history");
  const indexes = {
    withOccurrenceIndex: {
      byVersion: await explain(pool, "next_version"),
      byOccurrence: await explain(pool, "occurred_at"),
    },
  };
  await pool.query("DROP INDEX interlock_history_resource_idx");
  await pool.query("ANALYZE interlock_transition_history");
  indexes.withoutOccurrenceIndex = {
    byVersion: await explain(pool, "next_version"),
    byOccurrence: await explain(pool, "occurred_at"),
  };
  process.stdout.write(
    `${JSON.stringify(
      {
        environment: {
          node: process.version,
          postgres: (await pool.query("SHOW server_version")).rows[0]
            .server_version,
          schema,
          historyRows: 100_000,
        },
        artifacts,
        indexes,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await pool.end();
}
