import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  isInterlockError,
  parseVersionToken,
  type OutboxInsert,
  type TransitionRecord,
} from "@jajego/interlock";
import { createPermitService } from "../src/domain/permits/service.js";
import { PrismaInterlockDriver } from "../src/interlock/prisma-driver.js";
import { actors, permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

function messages(
  count: number,
  transitionId: string,
  topic = "probe",
): OutboxInsert[] {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    lifecycle: "permit",
    resourceType: "permit",
    resourceId: randomUUID(),
    transitionId,
    topic,
    key: String(index),
    payload: { index },
    createdAt: new Date(),
  }));
}

function history(): TransitionRecord {
  const previousVersion = parseVersionToken("1");
  const nextVersion = parseVersionToken("2");
  if (!previousVersion.success || !nextVersion.success)
    throw new Error("Static test versions must be valid.");
  return {
    id: randomUUID(),
    lifecycle: "permit",
    resourceType: "permit",
    resourceId: randomUUID(),
    event: "submit",
    fromState: "draft",
    toState: "submitted",
    previousVersion: previousVersion.value,
    nextVersion: nextVersion.value,
    occurredAt: new Date(),
  };
}

for (const count of [0, 1, 5, 20])
  test(`${count} outbox messages use ${count === 0 ? 0 : 1} statement`, async () => {
    const statements: string[] = [];
    const driver = new PrismaInterlockDriver(database, {
      observeStatement: (statement) => statements.push(statement),
    });
    const transition = history();
    await database.$transaction(async (transactionClient) => {
      await driver.insertTransition(transactionClient, transition);
      statements.length = 0;
      await driver.insertOutbox(
        transactionClient,
        messages(count, transition.id),
      );
    });
    assert.equal(
      statements.filter((statement) => statement === "outbox-insert").length,
      count === 0 ? 0 : 1,
    );
    assert.equal(
      await database.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint count FROM interlock.interlock_outbox
        WHERE topic = 'probe'
      `.then((rows) => Number(rows[0]?.count ?? 0n)),
      count,
    );
  });

test("outbox row-count mismatch fails and rolls back the batch", async () => {
  await database.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION reference_skip_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER reference_fail_outbox BEFORE INSERT ON interlock.interlock_outbox
    FOR EACH ROW WHEN (NEW.topic = 'skip') EXECUTE FUNCTION reference_skip_outbox();
  `);
  const driver = new PrismaInterlockDriver(database);
  const transition = history();
  await assert.rejects(
    database.$transaction(async (transactionClient) => {
      await driver.insertTransition(transactionClient, transition);
      await driver.insertOutbox(
        transactionClient,
        messages(2, transition.id, "skip"),
      );
    }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
  );
  assert.equal(
    await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint count FROM interlock.interlock_outbox
      WHERE topic = 'skip'
    `.then((rows) => Number(rows[0]?.count ?? 0n)),
    0,
  );
});

test("history row-count mismatch is rejected", async () => {
  await database.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION reference_skip_history() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER reference_fail_history BEFORE INSERT ON interlock.interlock_transition_history
    FOR EACH ROW EXECUTE FUNCTION reference_skip_history();
  `);
  const previous = parseVersionToken("1");
  const next = parseVersionToken("2");
  assert.equal(previous.success, true);
  assert.equal(next.success, true);
  if (!previous.success || !next.success) return;
  const transition: TransitionRecord = {
    id: randomUUID(),
    lifecycle: "permit",
    resourceType: "permit",
    resourceId: randomUUID(),
    event: "submit",
    fromState: "draft",
    toState: "submitted",
    previousVersion: previous.value,
    nextVersion: next.value,
    occurredAt: new Date(),
  };
  const driver = new PrismaInterlockDriver(database);
  await assert.rejects(
    database.$transaction((transaction) =>
      driver.insertTransition(transaction, transition),
    ),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
  );
});

for (const [sqlstate, code] of [
  ["40001", "INTERLOCK_SERIALIZATION_CONFLICT"],
  ["40P01", "INTERLOCK_DEADLOCK"],
  ["55P03", "INTERLOCK_LOCK_TIMEOUT"],
  ["57014", "INTERLOCK_CANCELLED"],
] as const)
  test(`Prisma transaction normalizes PostgreSQL ${sqlstate}`, async () => {
    const row = await permit(database, {
      state: "under_review",
      assignedReviewerId: actors.reviewer.id,
    });
    await database.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION reference_transient_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'transient failure' USING ERRCODE = '${sqlstate}'; END $$;
      CREATE TRIGGER reference_fail_primary BEFORE UPDATE ON permits
      FOR EACH ROW EXECUTE FUNCTION reference_transient_failure();
    `);
    const service = createPermitService(database);
    await assert.rejects(
      service.approve(
        {
          id: row.id,
          actor: actors.reviewer,
          expectedVersion: "1",
          idempotencyKey: `transient-${sqlstate}`,
        },
        {},
      ),
      (error) => isInterlockError(error) && error.code === code,
    );
  });
