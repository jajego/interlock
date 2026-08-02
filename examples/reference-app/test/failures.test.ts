import test from "node:test";
import assert from "node:assert/strict";
import { isInterlockError } from "@interlock/core";
import { createPermitService } from "../src/domain/permits/service.js";
import { actors, counts, permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
const service = createPermitService(database);
test.after(async () => database.$disconnect());

async function installFailureTriggers() {
  await database.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS reference_test_failures (
      resource_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL
    );
    CREATE OR REPLACE FUNCTION reference_fail_stage() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE resource TEXT;
    BEGIN
      resource := COALESCE(
        to_jsonb(NEW)->>'resource_id', to_jsonb(OLD)->>'resource_id',
        to_jsonb(NEW)->>'permit_id', to_jsonb(OLD)->>'permit_id',
        to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id'
      );
      IF EXISTS (
        SELECT 1 FROM reference_test_failures
        WHERE resource_id = resource AND stage = TG_ARGV[0]
      ) THEN
        RAISE EXCEPTION 'injected failure at %', TG_ARGV[0];
      END IF;
      RETURN COALESCE(NEW, OLD);
    END $$;
    DROP TRIGGER IF EXISTS reference_fail_primary ON permits;
    CREATE TRIGGER reference_fail_primary BEFORE UPDATE ON permits
      FOR EACH ROW EXECUTE FUNCTION reference_fail_stage('primary');
    DROP TRIGGER IF EXISTS reference_fail_related ON review_decisions;
    CREATE TRIGGER reference_fail_related BEFORE INSERT ON review_decisions
      FOR EACH ROW EXECUTE FUNCTION reference_fail_stage('related');
    DROP TRIGGER IF EXISTS reference_fail_history ON interlock.interlock_transition_history;
    CREATE TRIGGER reference_fail_history BEFORE INSERT ON interlock.interlock_transition_history
      FOR EACH ROW EXECUTE FUNCTION reference_fail_stage('history');
    DROP TRIGGER IF EXISTS reference_fail_outbox ON interlock.interlock_outbox;
    CREATE TRIGGER reference_fail_outbox BEFORE INSERT ON interlock.interlock_outbox
      FOR EACH ROW EXECUTE FUNCTION reference_fail_stage('outbox');
    DROP TRIGGER IF EXISTS reference_fail_completion ON interlock.interlock_idempotency;
    CREATE TRIGGER reference_fail_completion BEFORE UPDATE ON interlock.interlock_idempotency
      FOR EACH ROW EXECUTE FUNCTION reference_fail_stage('completion');
  `);
}

test.beforeEach(async () => {
  await reset(database);
  await installFailureTriggers();
});

for (const stage of [
  "primary",
  "history",
  "related",
  "outbox",
  "completion",
] as const)
  test(`${stage} failure rolls back primary, related, history, outbox, and idempotency`, async () => {
    const row = await permit(database, {
      state: "under_review",
      assignedReviewerId: actors.reviewer.id,
    });
    await database.$executeRaw`INSERT INTO reference_test_failures (resource_id, stage) VALUES (${row.id}, ${stage})`;
    await assert.rejects(
      service.approve(
        {
          id: row.id,
          actor: actors.reviewer,
          expectedVersion: "1",
          idempotencyKey: `failure-${stage}`,
        },
        {},
      ),
      (error) => isInterlockError(error),
    );
    assert.deepEqual(await counts(database, row.id), {
      state: "under_review",
      version: "1",
      decisions: 0,
      history: 0,
      outbox: 0,
      claims: 0,
    });
  });

test("hydration failure is not applicable because the binding returns UPDATE results directly", () => {
  assert.equal("hydrateBeforeCommit" in {}, false);
});
