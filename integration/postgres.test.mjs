import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { Pool } from "pg";
import {
  canonicalHash,
  createInterlock,
  defineLifecycle,
  isInterlockError,
  noInput,
} from "../packages/core/dist/index.js";
import { PostgresDriver } from "../packages/postgres/dist/index.js";
import {
  verifyExecutorAtomicity,
  verifyResourceBinding,
  verifyTransactionDriver,
} from "../packages/conformance/dist/index.js";
import {
  applicationBinding,
  applicationLifecycle,
  createApplications,
} from "../examples/postgres-node/dist/index.js";

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
    "CREATE TABLE conformance_markers (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)",
  );
  await resetApplication(pool);
  return { pool, applications: createApplications(pool) };
}

async function resetApplication(pool) {
  await pool.query(
    "TRUNCATE applications, application_documents, application_decisions, interlock_idempotency, interlock_outbox, interlock_transition_history RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "INSERT INTO applications (id, owner_id, state) VALUES ('a1', 'owner', 'under_review')",
  );
  await pool.query(
    "INSERT INTO application_documents (id, application_id, verified) VALUES ('d1', 'a1', true)",
  );
}

test(
  "migration installs the complete schema atomically on an empty database",
  { skip },
  async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await pool.query(migration);
      const result = await pool.query(`SELECT
      to_regclass('interlock_transition_history') IS NOT NULL AS history,
      to_regclass('interlock_idempotency') IS NOT NULL AS idempotency,
      to_regclass('interlock_outbox') IS NOT NULL AS outbox,
      to_regclass('interlock_history_resource_version_idx') IS NOT NULL AS version_index`);
      assert.deepEqual(result.rows[0], {
        history: true,
        idempotency: true,
        outbox: true,
        version_index: true,
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  "migration can be reapplied without losing existing data",
  { skip },
  async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await pool.query(migration);
      await pool.query(`INSERT INTO interlock_transition_history (
      id, lifecycle, resource_type, resource_id, event, from_state, to_state,
      previous_version, next_version, occurred_at
    ) VALUES ('existing', 'item', 'item', 'item-1', 'move', 'a', 'b', 1, 2, now())`);
      await pool.query(migration);
      const result = await pool.query(
        "SELECT id FROM interlock_transition_history WHERE id = 'existing'",
      );
      assert.deepEqual(result.rows, [{ id: "existing" }]);
    } finally {
      await pool.end();
    }
  },
);

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
        expectedVersion: "2",
        idempotency: { key: "k1" },
      };
      const first = await applications.transition(request);
      const replay = await applications.transition(request);
      assert.equal(first.status, "committed");
      assert.equal(replay.status, "committed");
      if (first.status === "committed" && replay.status === "committed") {
        assert.equal(first.transition.id, replay.transition.id);
        assert.equal(
          first.transition.occurredAt.getTime(),
          replay.transition.occurredAt.getTime(),
        );
      }
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
  "same idempotency key racing produces one mutation and one transition identity",
  { skip },
  async () => {
    const { pool, applications } = await fixture();
    try {
      const request = {
        id: "a1",
        event: "approve",
        input: { note: "Ready" },
        actor: reviewer,
        expectedVersion: "2",
        idempotency: { key: "same-key" },
      };
      const results = await Promise.all([
        applications.transition(request),
        applications.transition(request),
      ]);
      assert.ok(results.every((result) => result.status === "committed"));
      assert.equal(results[0].transition.id, results[1].transition.id);
      assert.deepEqual(results.map((result) => result.duplicate).sort(), [
        false,
        true,
      ]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int count FROM application_decisions",
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
  "document writes invalidate an approval through aggregate versioning",
  { skip },
  async () => {
    const { pool } = await fixture();
    let checked;
    let resume;
    const guardChecked = new Promise((resolve) => {
      checked = resolve;
    });
    const mayContinue = new Promise((resolve) => {
      resume = resolve;
    });
    const binding = {
      ...applicationBinding,
      contextFactory: {
        create(transaction, options) {
          const context = applicationBinding.contextFactory.create(
            transaction,
            options,
          );
          return {
            documents: {
              async allVerified(id) {
                const result = await context.documents.allVerified(id);
                if (options.mode === "authoritative") {
                  checked();
                  await mayContinue;
                }
                return result;
              },
            },
          };
        },
      },
    };
    const applications = createInterlock({
      lifecycle: applicationLifecycle,
      driver: new PostgresDriver(pool),
      binding,
    });
    try {
      const pending = applications.transition({
        id: "a1",
        event: "approve",
        input: {},
        actor: reviewer,
        expectedVersion: "2",
        idempotency: { key: "related-race" },
      });
      await guardChecked;
      await pool.query(
        "INSERT INTO application_documents (id, application_id, verified) VALUES ('d2', 'a1', false)",
      );
      resume();
      assert.equal((await pending).status, "conflict");
    } finally {
      await pool.end();
    }
  },
);

test("moving a document bumps both aggregate parents", { skip }, async () => {
  const { pool } = await fixture();
  try {
    await pool.query(
      "INSERT INTO applications (id, owner_id, state) VALUES ('a2', 'owner', 'under_review')",
    );
    await pool.query(
      "UPDATE application_documents SET application_id = 'a2' WHERE id = 'd1'",
    );
    const versions = await pool.query(
      "SELECT id, version::text FROM applications ORDER BY id",
    );
    assert.deepEqual(versions.rows, [
      { id: "a1", version: "3" },
      { id: "a2", version: "2" },
    ]);
  } finally {
    await pool.end();
  }
});

test(
  "PostgreSQL driver satisfies the public conformance suite",
  { skip },
  async () => {
    const { pool } = await fixture();
    const driver = new PostgresDriver(pool);
    const occurredAt = new Date("2026-01-01T00:00:00.000Z");
    const transition = {
      id: "conformance-transition",
      lifecycle: "conformance",
      resourceType: "item",
      resourceId: "item-1",
      event: "move",
      fromState: "a",
      toState: "b",
      previousVersion: "1",
      nextVersion: "2",
      occurredAt,
    };
    try {
      await verifyTransactionDriver({
        driver,
        reset: async () => {
          await pool.query(
            "TRUNCATE conformance_markers, interlock_idempotency, interlock_outbox, interlock_transition_history RESTART IDENTITY CASCADE",
          );
        },
        writeMarker: async (transaction) => {
          await transaction.query(
            "INSERT INTO conformance_markers DEFAULT VALUES",
          );
        },
        markerCount: async () =>
          Number(
            (
              await pool.query(
                "SELECT count(*)::int count FROM conformance_markers",
              )
            ).rows[0].count,
          ),
        settings: async (transaction) => {
          const result = await transaction.query(
            "SELECT current_setting('transaction_isolation') isolation, current_setting('transaction_read_only') read_only",
          );
          return {
            isolation: result.rows[0].isolation,
            readOnly: result.rows[0].read_only === "on",
          };
        },
        probe: async (transaction) => {
          await transaction.query("SELECT 1");
        },
        transition,
        outbox: {
          id: "conformance-outbox",
          lifecycle: "conformance",
          resourceType: "item",
          resourceId: "item-1",
          transitionId: transition.id,
          topic: "item.moved",
          payload: {},
          createdAt: occurredAt,
        },
        historyCount: async (id) =>
          Number(
            (
              await pool.query(
                "SELECT count(*)::int count FROM interlock_transition_history WHERE id = $1",
                [id],
              )
            ).rows[0].count,
          ),
        outboxCount: async (id) =>
          Number(
            (
              await pool.query(
                "SELECT count(*)::int count FROM interlock_outbox WHERE id = $1",
                [id],
              )
            ).rows[0].count,
          ),
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  "reference binding satisfies the public verification suite",
  { skip },
  async () => {
    const { pool } = await fixture();
    try {
      await verifyResourceBinding({
        driver: new PostgresDriver(pool),
        binding: applicationBinding,
        reset: () => resetApplication(pool),
        id: "a1",
        event: "approve",
        fromState: "under_review",
        toState: "approved",
        expectedVersion: "2",
        staleVersion: "1",
        nextVersion: "3",
        invalidSourceState: "approved",
        mutation: { decisionNote: "verified" },
        advisoryOptions: { isolation: "read-committed", readOnly: true },
        authoritativeOptions: { isolation: "read-committed" },
        assertContext: async (context) => {
          assert.equal(await context.documents.allVerified("a1"), true);
        },
        relatedCount: async () =>
          Number(
            (
              await pool.query(
                "SELECT count(*)::int count FROM application_decisions",
              )
            ).rows[0].count,
          ),
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  "executor conformance proves history, outbox, and completion rollback",
  { skip },
  async () => {
    const { pool } = await fixture();
    const driver = new PostgresDriver(pool);
    try {
      await verifyExecutorAtomicity({
        driver,
        reset: () => resetApplication(pool),
        transition: (candidate) =>
          createApplications(pool, candidate).transition({
            id: "a1",
            event: "approve",
            input: {},
            actor: reviewer,
            expectedVersion: "2",
            idempotency: { key: "fault" },
          }),
        snapshot: async () => {
          const result = await pool.query(`SELECT
          (SELECT version::text FROM applications WHERE id = 'a1') primary_version,
          (SELECT count(*)::int FROM application_decisions) related,
          (SELECT count(*)::int FROM interlock_transition_history) history,
          (SELECT count(*)::int FROM interlock_outbox) outbox,
          (SELECT count(*)::int FROM interlock_idempotency) idempotency`);
          return {
            primaryVersion: result.rows[0].primary_version,
            related: result.rows[0].related,
            history: result.rows[0].history,
            outbox: result.rows[0].outbox,
            idempotency: result.rows[0].idempotency,
          };
        },
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
        expectedVersion: "2",
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
        expectedVersion: "2",
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

test(
  "same key with different fingerprints or expected versions collides",
  { skip },
  async () => {
    const { pool, applications } = await fixture();
    try {
      const first = await applications.transition({
        id: "a1",
        event: "approve",
        input: { note: "first" },
        actor: reviewer,
        expectedVersion: "2",
        idempotency: { key: "collision" },
      });
      assert.equal(first.status, "committed");
      const differentInput = await applications.transition({
        id: "a1",
        event: "approve",
        input: { note: "different" },
        actor: reviewer,
        expectedVersion: "2",
        idempotency: { key: "collision" },
      });
      const differentVersion = await applications.transition({
        id: "a1",
        event: "approve",
        input: { note: "first" },
        actor: reviewer,
        expectedVersion: "3",
        idempotency: { key: "collision" },
      });
      assert.equal(differentInput.status, "idempotency-conflict");
      assert.equal(differentVersion.status, "idempotency-conflict");
    } finally {
      await pool.end();
    }
  },
);

test(
  "not-found and stale-version attempts do not consume claims",
  { skip },
  async () => {
    const { pool, applications } = await fixture();
    try {
      const missing = await applications.transition({
        id: "missing",
        event: "approve",
        input: {},
        actor: reviewer,
        expectedVersion: "1",
        idempotency: { key: "missing" },
      });
      const stale = await applications.transition({
        id: "a1",
        event: "approve",
        input: {},
        actor: reviewer,
        expectedVersion: "1",
        idempotency: { key: "stale" },
      });
      assert.equal(missing.status, "not-found");
      assert.equal(stale.status, "conflict");
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

test(
  "owner rollback allows a concurrent claimant to proceed",
  { skip },
  async () => {
    const { pool } = await fixture();
    const driver = new PostgresDriver(pool);
    let releaseOwner;
    let ownerClaimed;
    const ownerReady = new Promise((resolve) => {
      ownerClaimed = resolve;
    });
    const release = new Promise((resolve) => {
      releaseOwner = resolve;
    });
    const ownerFailure = { owner: true };
    const competitorFailure = { competitor: true };
    const claim = {
      lifecycle: "application",
      resourceId: "a1",
      key: "owner-rollback-race",
      fingerprint: "same",
      createdAt: new Date(),
    };
    try {
      const owner = driver.transaction(async (transaction) => {
        assert.equal(
          (await driver.claimIdempotency(transaction, claim)).status,
          "claimed",
        );
        ownerClaimed();
        await release;
        throw ownerFailure;
      });
      await ownerReady;
      const competitor = driver.transaction(async (transaction) => {
        assert.equal(
          (await driver.claimIdempotency(transaction, claim)).status,
          "claimed",
        );
        throw competitorFailure;
      });
      releaseOwner();
      await assert.rejects(owner, (error) => error === ownerFailure);
      await assert.rejects(competitor, (error) => error === competitorFailure);
    } finally {
      await pool.end();
    }
  },
);

test(
  "duplicate resolution precedes current policy and resource loading",
  { skip },
  async () => {
    const { pool } = await fixture();
    let policyAllowed = true;
    let policyCalls = 0;
    const lifecycle = defineLifecycle()({
      name: "duplicate-policy",
      states: ["under_review", "approved"],
      history: { resourceType: "application" },
      idempotency: {
        fingerprint: ({ resourceId, event, expectedVersion }) =>
          canonicalHash({ resourceId, event, expectedVersion }),
      },
      events: {
        approve: {
          from: ["under_review"],
          to: "approved",
          input: noInput,
          authorize: () => {
            policyCalls += 1;
            return policyAllowed
              ? { allowed: true }
              : { allowed: false, denial: { code: "POLICY_CHANGED" } };
          },
          mutate: () => ({ decisionNote: null }),
        },
      },
    });
    const applications = createInterlock({
      lifecycle,
      driver: new PostgresDriver(pool),
      binding: applicationBinding,
    });
    const request = {
      id: "a1",
      event: "approve",
      actor: undefined,
      expectedVersion: "2",
      idempotency: { key: "historical-result" },
    };
    try {
      const first = await applications.transition(request);
      assert.equal(first.status, "committed");
      policyAllowed = false;
      await pool.query(
        "DELETE FROM application_documents WHERE application_id = 'a1'",
      );
      await pool.query(
        "DELETE FROM application_decisions WHERE application_id = 'a1'",
      );
      await pool.query("DELETE FROM applications WHERE id = 'a1'");
      const replay = await applications.transition(request);
      assert.equal(replay.status, "committed");
      assert.equal(replay.duplicate, true);
      assert.equal("resource" in replay, false);
      assert.equal(policyCalls, 1);
    } finally {
      await pool.end();
    }
  },
);

test(
  "in-transaction hydration failure rolls back every write",
  { skip },
  async () => {
    const { pool } = await fixture();
    const applications = createInterlock({
      lifecycle: applicationLifecycle,
      driver: new PostgresDriver(pool),
      binding: {
        ...applicationBinding,
        hydrateBeforeCommit: async () => {
          throw new Error("injected hydration failure");
        },
      },
    });
    try {
      await assert.rejects(
        applications.transition({
          id: "a1",
          event: "approve",
          input: {},
          actor: reviewer,
          expectedVersion: "2",
          idempotency: { key: "hydrate" },
        }),
        (error) =>
          isInterlockError(error) &&
          error.code === "INTERLOCK_PERSISTENCE_FAILED" &&
          error.cause?.message === "injected hydration failure",
      );
      const result = await pool.query(`SELECT
      (SELECT version::text FROM applications WHERE id = 'a1') version,
      (SELECT count(*)::int FROM application_decisions) related,
      (SELECT count(*)::int FROM interlock_transition_history) history,
      (SELECT count(*)::int FROM interlock_outbox) outbox,
      (SELECT count(*)::int FROM interlock_idempotency) idempotency`);
      assert.deepEqual(result.rows[0], {
        version: "2",
        related: 0,
        history: 0,
        outbox: 0,
        idempotency: 0,
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  "higher isolation idempotency is rejected before PostgreSQL writes",
  { skip },
  async () => {
    const { pool } = await fixture();
    try {
      for (const isolation of ["repeatable-read", "serializable"]) {
        const applications = createInterlock({
          lifecycle: applicationLifecycle,
          driver: new PostgresDriver(pool),
          binding: {
            ...applicationBinding,
            transactionOptions: () => ({ isolation }),
          },
        });
        await assert.rejects(
          applications.transition({
            id: "a1",
            event: "approve",
            input: {},
            actor: reviewer,
            expectedVersion: "2",
            idempotency: { key: isolation },
          }),
          (error) =>
            isInterlockError(error) &&
            error.code === "INTERLOCK_DRIVER_UNSUPPORTED",
        );
        const count = await pool.query(
          "SELECT count(*)::int count FROM interlock_idempotency",
        );
        assert.equal(count.rows[0].count, 0);
      }
    } finally {
      await pool.end();
    }
  },
);

test("invalid hydrated resources roll back every write", { skip }, async () => {
  const { pool } = await fixture();
  try {
    for (const resource of [
      { id: "wrong", state: "approved", version: "3" },
      { id: "a1", state: "under_review", version: "3" },
      { id: "a1", state: "approved", version: "2" },
    ]) {
      const applications = createInterlock({
        lifecycle: applicationLifecycle,
        driver: new PostgresDriver(pool),
        binding: {
          ...applicationBinding,
          hydrateBeforeCommit: async () => resource,
        },
      });
      await assert.rejects(
        applications.transition({
          id: "a1",
          event: "approve",
          input: {},
          actor: reviewer,
          expectedVersion: "2",
          idempotency: { key: "invalid-hydration" },
        }),
        (error) =>
          isInterlockError(error) &&
          error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      );
      const result = await pool.query(`SELECT
          (SELECT version::text FROM applications WHERE id = 'a1') version,
          (SELECT count(*)::int FROM application_decisions) related,
          (SELECT count(*)::int FROM interlock_transition_history) history,
          (SELECT count(*)::int FROM interlock_outbox) outbox,
          (SELECT count(*)::int FROM interlock_idempotency) idempotency`);
      assert.deepEqual(result.rows[0], {
        version: "2",
        related: 0,
        history: 0,
        outbox: 0,
        idempotency: 0,
      });
    }
  } finally {
    await pool.end();
  }
});

test(
  "connection loss during execution rolls back the transition",
  { skip },
  async () => {
    const { pool } = await fixture();
    const applications = createInterlock({
      lifecycle: applicationLifecycle,
      driver: new PostgresDriver(pool),
      binding: {
        ...applicationBinding,
        applyPrimary: async (transaction, args) => {
          const pid = await transaction.query("SELECT pg_backend_pid() pid");
          await pool.query("SELECT pg_terminate_backend($1)", [
            pid.rows[0].pid,
          ]);
          return applicationBinding.applyPrimary(transaction, args);
        },
      },
    });
    try {
      await assert.rejects(
        applications.transition({
          id: "a1",
          event: "approve",
          input: {},
          actor: reviewer,
          expectedVersion: "2",
          idempotency: { key: "connection-drop" },
        }),
        (error) =>
          isInterlockError(error) &&
          error.code === "INTERLOCK_PERSISTENCE_FAILED",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT version::text version FROM applications WHERE id = 'a1'",
          )
        ).rows[0].version,
        "2",
      );
    } finally {
      await pool.end();
    }
  },
);
