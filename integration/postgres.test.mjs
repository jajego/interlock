import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { Pool } from "pg";
import { createApplications } from "../examples/postgres-node/dist/index.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url
  ? false
  : "TEST_DATABASE_URL is required for real PostgreSQL guarantees";
const migration = await readFile(
  new URL("../packages/postgres/migrations/001_interlock.sql", import.meta.url),
  "utf8",
);
const applicationSchema = await readFile(
  new URL("../examples/postgres-node/schema.sql", import.meta.url),
  "utf8",
);

async function fixture() {
  const pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await pool.query(migration);
  await pool.query(applicationSchema);
  await pool.query(
    "INSERT INTO applications (id, owner_id, state) VALUES ('a1', 'owner', 'under_review')",
  );
  await pool.query(
    "INSERT INTO application_documents (id, application_id, verified) VALUES ('d1', 'a1', true)",
  );
  return { pool, applications: createApplications(pool) };
}

const reviewer = {
  id: "reviewer",
  permissions: ["applications:approve", "applications:reject"],
};

test(
  "resource, related write, history, idempotency and outbox commit together",
  { skip },
  async () => {
    const { pool, applications } = await fixture();
    try {
      const request = {
        id: "a1",
        event: "approve",
        input: { note: "Ready" },
        actor: reviewer,
        expectedVersion: "1",
        idempotency: { key: "k1" },
      };
      const first = await applications.transition(request);
      const replay = await applications.transition(request);
      assert.equal(first.status, "committed");
      assert.equal(replay.status, "committed");
      if (first.status === "committed" && replay.status === "committed")
        assert.equal(first.transition.id, replay.transition.id);
      const counts = await pool.query(`SELECT
      (SELECT count(*) FROM application_decisions)::int decisions,
      (SELECT count(*) FROM interlock_transition_history)::int history,
      (SELECT count(*) FROM interlock_idempotency)::int idempotency,
      (SELECT count(*) FROM interlock_outbox)::int outbox`);
      assert.deepEqual(counts.rows[0], {
        decisions: 1,
        history: 1,
        idempotency: 1,
        outbox: 1,
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  "different commands against one version produce one commit and one conflict",
  { skip },
  async () => {
    const { pool, applications } = await fixture();
    try {
      const base = {
        id: "a1",
        input: { note: "Decision" },
        actor: reviewer,
        expectedVersion: "1",
      };
      const results = await Promise.all([
        applications.transition({
          ...base,
          event: "approve",
          idempotency: { key: "approve" },
        }),
        applications.transition({
          ...base,
          event: "reject",
          idempotency: { key: "reject" },
        }),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [
        "committed",
        "conflict",
      ]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int count FROM interlock_transition_history",
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "denial after claim rolls back without consuming the key",
  { skip },
  async () => {
    const { pool, applications } = await fixture();
    try {
      const result = await applications.transition({
        id: "a1",
        event: "approve",
        input: {},
        actor: { id: "visitor", permissions: [] },
        expectedVersion: "1",
        idempotency: { key: "denied" },
      });
      assert.equal(result.status, "denied");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int count FROM interlock_idempotency",
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await pool.end();
    }
  },
);
