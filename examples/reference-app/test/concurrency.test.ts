import test from "node:test";
import assert from "node:assert/strict";
import { createPermitService } from "../src/domain/permits/service.js";
import { actors, counts, permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
const service = createPermitService(database);
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

test("same version races produce one winner", async () => {
  const row = await permit(database, { withDocument: true });
  const options = {
    id: row.id,
    actor: actors.applicant,
    expectedVersion: String(row.version),
  };
  const results = await Promise.all([
    service.submit({ ...options, idempotencyKey: "race-a" }, {}),
    service.submit({ ...options, idempotencyKey: "race-b" }, {}),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "committed",
    "conflict",
  ]);
});

test("simultaneous approve and reject produce one winner", async () => {
  const row = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
  });
  const options = { id: row.id, actor: actors.reviewer, expectedVersion: "1" };
  const results = await Promise.all([
    service.approve({ ...options, idempotencyKey: "approve" }, {}),
    service.reject({ ...options, idempotencyKey: "reject" }, { reason: "No" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "committed",
    "conflict",
  ]);
  assert.equal((await counts(database, row.id)).decisions, 1);
});

test("idempotent retry returns the original transition without extra writes", async () => {
  const row = await permit(database, { withDocument: true });
  const options = {
    id: row.id,
    actor: actors.applicant,
    expectedVersion: String(row.version),
    idempotencyKey: "stable",
  };
  const first = await service.submit(options, {});
  const duplicate = await service.submit(options, {});
  assert.equal(first.status, "committed");
  assert.equal(duplicate.status, "committed");
  if (first.status === "committed" && duplicate.status === "committed") {
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.transition.id, duplicate.transition.id);
  }
  assert.deepEqual(await counts(database, row.id), {
    state: "submitted",
    version: "3",
    decisions: 0,
    history: 1,
    outbox: 0,
    claims: 1,
  });
  const conflict = await service.submit(
    { ...options, idempotencyKey: "stable" },
    { note: "different" },
  );
  assert.equal(conflict.status, "idempotency-conflict");
});
