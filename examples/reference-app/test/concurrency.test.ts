import test from "node:test";
import assert from "node:assert/strict";
import { createPermitService } from "../src/domain/permits/service.js";
import type { Transaction } from "../src/db.js";
import { actors, counts, permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
const service = createPermitService(database);
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

async function hold(change: (transaction: Transaction) => Promise<unknown>) {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const releasePromise = new Promise<void>((resolve) => (release = resolve));
  const transaction = database.$transaction(async (scoped) => {
    await change(scoped);
    entered();
    await releasePromise;
  });
  await enteredPromise;
  return async () => {
    release();
    await transaction;
  };
}

function approval(id: string, key: string) {
  return service.approve(
    {
      id,
      actor: actors.reviewer,
      expectedVersion: "1",
      idempotencyKey: key,
    },
    {},
  );
}

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

test("membership revocation racing with approval is authoritative", async () => {
  const row = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
  });
  const release = await hold((transaction) =>
    transaction.tenantMembership.delete({
      where: {
        tenantId_userId: {
          tenantId: actors.reviewer.tenantId,
          userId: actors.reviewer.id,
        },
      },
    }),
  );
  const pending = approval(row.id, "revoked");
  await release();
  const result = await pending;
  assert.equal(result.status, "denied");
  assert.deepEqual(await counts(database, row.id), {
    state: "under_review",
    version: "1",
    decisions: 0,
    history: 0,
    outbox: 0,
    claims: 0,
  });
});

test("membership role downgrade racing with approval is authoritative", async () => {
  const row = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
  });
  const release = await hold((transaction) =>
    transaction.tenantMembership.update({
      where: {
        tenantId_userId: {
          tenantId: actors.reviewer.tenantId,
          userId: actors.reviewer.id,
        },
      },
      data: { role: "applicant" },
    }),
  );
  const pending = approval(row.id, "downgraded");
  await release();
  assert.equal((await pending).status, "denied");
  assert.equal((await counts(database, row.id)).state, "under_review");
});

for (const event of ["approve", "reject"] as const)
  test(`assignment change racing with ${event} rejects the previous reviewer`, async () => {
    const row = await permit(database, {
      state: "under_review",
      assignedReviewerId: actors.reviewer.id,
    });
    const release = await hold((transaction) =>
      transaction.reviewAssignment.update({
        where: { permitId: row.id },
        data: { reviewerId: actors.candidate.id },
      }),
    );
    const pending =
      event === "approve"
        ? approval(row.id, "assignment-approve")
        : service.reject(
            {
              id: row.id,
              actor: actors.reviewer,
              expectedVersion: "1",
              idempotencyKey: "assignment-reject",
            },
            { reason: "No" },
          );
    await release();
    assert.equal((await pending).status, "denied");
    assert.equal((await counts(database, row.id)).decisions, 0);
    assert.equal(
      (
        await database.reviewAssignment.findUniqueOrThrow({
          where: { permitId: row.id },
        })
      ).reviewerId,
      actors.candidate.id,
    );
  });

test("document removal racing with submission invalidates the observed aggregate", async () => {
  const row = await permit(database, { withDocument: true });
  const document = await database.permitDocument.findFirstOrThrow({
    where: { permitId: row.id },
  });
  const release = await hold((transaction) =>
    transaction.permitDocument.delete({ where: { id: document.id } }),
  );
  const pending = service.submit(
    {
      id: row.id,
      actor: actors.applicant,
      expectedVersion: String(row.version),
      idempotencyKey: "document-race",
    },
    {},
  );
  await release();
  const result = await pending;
  assert.ok(result.status === "conflict" || result.status === "denied");
  assert.equal(
    await database.permitDocument.count({ where: { permitId: row.id } }),
    0,
  );
  assert.deepEqual(await counts(database, row.id), {
    state: "draft",
    version: String(row.version + 1n),
    decisions: 0,
    history: 0,
    outbox: 0,
    claims: 0,
  });
});

test("document reassignment racing with submission invalidates the source aggregate", async () => {
  const source = await permit(database, {
    withDocument: true,
    permitNumber: 201,
  });
  const destination = await permit(database, { permitNumber: 202 });
  const document = await database.permitDocument.findFirstOrThrow({
    where: { permitId: source.id },
  });
  const release = await hold(async (transaction) => {
    await transaction.$queryRaw`
      SELECT id FROM permits WHERE id = ${source.id} FOR UPDATE
    `;
    await transaction.permitDocument.update({
      where: { id: document.id },
      data: { permitId: destination.id },
    });
  });
  let reachedPrimaryUpdate!: () => void;
  const primaryUpdateReached = new Promise<void>(
    (resolve) => (reachedPrimaryUpdate = resolve),
  );
  const coordinatedService = createPermitService(database, {
    observeStatement: (statement) => {
      if (statement === "primary-update") reachedPrimaryUpdate();
    },
  });
  const pending = coordinatedService.submit(
    {
      id: source.id,
      actor: actors.applicant,
      expectedVersion: String(source.version),
      idempotencyKey: "document-move-race",
    },
    {},
  );
  await primaryUpdateReached;
  await release();

  const result = await pending;
  assert.equal(result.status, "conflict");
  assert.equal(
    (
      await database.permitDocument.findUniqueOrThrow({
        where: { id: document.id },
      })
    ).permitId,
    destination.id,
  );
  assert.equal(
    await database.permitDocument.count({ where: { permitId: source.id } }),
    0,
  );
  assert.equal(
    await database.permitDocument.count({
      where: { permitId: destination.id },
    }),
    1,
  );
  assert.deepEqual(await counts(database, source.id), {
    state: "draft",
    version: String(source.version + 1n),
    decisions: 0,
    history: 0,
    outbox: 0,
    claims: 0,
  });
  assert.equal(
    (
      await database.permit.findUniqueOrThrow({
        where: { id: destination.id },
      })
    ).version,
    2n,
  );
});

test("candidate membership removal racing with beginReview is authoritative", async () => {
  const row = await permit(database, { state: "submitted" });
  const release = await hold((transaction) =>
    transaction.tenantMembership.delete({
      where: {
        tenantId_userId: {
          tenantId: actors.candidate.tenantId,
          userId: actors.candidate.id,
        },
      },
    }),
  );
  const pending = service.beginReview(
    {
      id: row.id,
      actor: actors.reviewer,
      expectedVersion: "1",
      idempotencyKey: "candidate-race",
    },
    { reviewerId: actors.candidate.id },
  );
  await release();
  assert.equal((await pending).status, "denied");
  assert.equal((await counts(database, row.id)).state, "submitted");
  assert.equal(
    await database.reviewAssignment.count({ where: { permitId: row.id } }),
    0,
  );
});

test("same-key concurrent commands resolve to one commit and one duplicate", async () => {
  const row = await permit(database, { withDocument: true });
  const options = {
    id: row.id,
    actor: actors.applicant,
    expectedVersion: String(row.version),
    idempotencyKey: "same-key",
  };
  const results = await Promise.all([
    service.submit(options, {}),
    service.submit(options, {}),
  ]);
  assert.deepEqual(
    results
      .map((result) =>
        result.status === "committed" ? result.duplicate : result.status,
      )
      .sort(),
    [false, true],
  );
  assert.equal((await counts(database, row.id)).history, 1);
});

test("same-key different-fingerprint concurrency returns a stable conflict", async () => {
  const row = await permit(database, { withDocument: true });
  const options = {
    id: row.id,
    actor: actors.applicant,
    expectedVersion: String(row.version),
    idempotencyKey: "different-fingerprint",
  };
  const results = await Promise.all([
    service.submit(options, { note: "first" }),
    service.submit(options, { note: "second" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "committed",
    "idempotency-conflict",
  ]);
  assert.equal((await counts(database, row.id)).history, 1);
});
