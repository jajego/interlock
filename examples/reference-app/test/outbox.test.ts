import test from "node:test";
import assert from "node:assert/strict";
import { createPermitService } from "../src/domain/permits/service.js";
import { processOne } from "../src/workers/outbox.js";
import { actors, counts, permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
const service = createPermitService(database);
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

async function approvedPermit() {
  const row = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
  });
  const result = await service.approve(
    {
      id: row.id,
      actor: actors.reviewer,
      expectedVersion: "1",
      idempotencyKey: "approve",
    },
    {},
  );
  assert.equal(result.status, "committed");
  return row.id;
}

test("commits create one outbox row and duplicate retries create no more", async () => {
  const id = await approvedPermit();
  const duplicate = await service.approve(
    {
      id,
      actor: actors.reviewer,
      expectedVersion: "1",
      idempotencyKey: "approve",
    },
    {},
  );
  assert.equal(duplicate.status, "committed");
  assert.equal((await counts(database, id)).outbox, 1);
});

test("the worker holds the row lock during delivery and excludes another worker", async () => {
  await approvedPermit();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const releasePromise = new Promise<void>((resolve) => (release = resolve));
  const first = processOne(database, "worker-a", async () => {
    entered();
    await releasePromise;
  });
  await enteredPromise;
  const second = await processOne(database, "worker-b");
  release();
  assert.equal(second, undefined);
  assert.ok(await first);
  assert.equal(await database.deliveredNotification.count(), 1);
});

test("worker failure rolls back delivery and leaves the row retryable", async () => {
  await approvedPermit();
  await assert.rejects(
    processOne(database, "worker-a", async () => {
      throw new Error("delivery unavailable");
    }),
  );
  assert.equal(await database.deliveredNotification.count(), 0);
  assert.ok(await processOne(database, "worker-b"));
  assert.equal(await database.deliveredNotification.count(), 1);
});

test("external success before acknowledgement failure demonstrates at-least-once delivery", async () => {
  await approvedPermit();
  let externalDeliveries = 0;
  await assert.rejects(
    processOne(database, "worker-a", async () => {
      externalDeliveries += 1;
      throw new Error("database acknowledgement was not reached");
    }),
  );
  await processOne(database, "worker-b", async () => {
    externalDeliveries += 1;
  });
  assert.equal(externalDeliveries, 2);
  assert.equal(await database.deliveredNotification.count(), 1);
});
