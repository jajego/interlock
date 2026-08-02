import assert from "node:assert/strict";
import type {
  OutboxInsert,
  TransactionDriver,
  TransitionRecord,
} from "@interlock/core";

/**
 * Isolated, resettable persistence fixture consumed by
 * `verifyTransactionDriver()`. Verification creates and mutates real records.
 */
export interface DriverConformance<Transaction> {
  driver: TransactionDriver<Transaction>;
  reset(): Promise<void>;
  writeMarker(transaction: Transaction): Promise<void>;
  markerCount(): Promise<number>;
  settings(transaction: Transaction): Promise<{
    isolation: string;
    readOnly: boolean;
  }>;
  probe(transaction: Transaction): Promise<void>;
  transition: TransitionRecord;
  outbox: OutboxInsert;
  historyCount(id: string): Promise<number>;
  outboxCount(id: string): Promise<number>;
}

/**
 * Executes commit, rollback, options, handle-lifetime, history, outbox, and
 * idempotency checks against the supplied driver fixture. The fixture must be
 * isolated and resettable; failed assertions reject. Intended for adapter
 * authors.
 */
export async function verifyTransactionDriver<Transaction>(
  fixture: DriverConformance<Transaction>,
): Promise<void> {
  const { driver } = fixture;
  await fixture.reset();
  await driver.transaction((transaction) => fixture.writeMarker(transaction));
  assert.equal(await fixture.markerCount(), 1, "transaction commits");

  await fixture.reset();
  const rollback = { expected: "rollback" };
  await assert.rejects(
    driver.transaction(async (transaction) => {
      await fixture.writeMarker(transaction);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.equal(
    await fixture.markerCount(),
    0,
    "transaction rolls back thrown values",
  );

  await driver.transaction(
    async (transaction) => {
      assert.deepEqual(await fixture.settings(transaction), {
        isolation: "serializable",
        readOnly: true,
      });
      await assert.rejects(fixture.writeMarker(transaction));
    },
    { isolation: "serializable", readOnly: true },
  );

  let expired: Transaction | undefined;
  await driver.transaction(async (transaction) => {
    expired = transaction;
  });
  assert.ok(expired);
  await assert.rejects(fixture.probe(expired), /after completion/i);

  await fixture.reset();
  await driver.transaction(async (transaction) => {
    await driver.insertTransition(transaction, fixture.transition);
    await driver.insertOutbox(transaction, [fixture.outbox]);
  });
  assert.equal(await fixture.historyCount(fixture.transition.id), 1);
  assert.equal(await fixture.outboxCount(fixture.outbox.id), 1);

  await driver.transaction(async (transaction) => {
    const claim = await driver.claimIdempotency(transaction, {
      lifecycle: fixture.transition.lifecycle,
      resourceId: fixture.transition.resourceId,
      key: "committed-duplicate",
      fingerprint: "same",
      createdAt: fixture.transition.occurredAt,
    });
    assert.equal(claim.status, "claimed");
    await driver.completeIdempotency(transaction, {
      lifecycle: fixture.transition.lifecycle,
      resourceId: fixture.transition.resourceId,
      key: "committed-duplicate",
      transitionId: fixture.transition.id,
      completedAt: fixture.transition.occurredAt,
    });
  });
  await driver.transaction(async (transaction) => {
    const duplicate = await driver.claimIdempotency(transaction, {
      lifecycle: fixture.transition.lifecycle,
      resourceId: fixture.transition.resourceId,
      key: "committed-duplicate",
      fingerprint: "same",
      createdAt: fixture.transition.occurredAt,
    });
    assert.equal(duplicate.status, "duplicate");
    if (duplicate.status === "duplicate")
      assert.equal(duplicate.transition.id, fixture.transition.id);
    const conflict = await driver.claimIdempotency(transaction, {
      lifecycle: fixture.transition.lifecycle,
      resourceId: fixture.transition.resourceId,
      key: "committed-duplicate",
      fingerprint: "different",
      createdAt: fixture.transition.occurredAt,
    });
    assert.equal(conflict.status, "conflict");
  });

  await fixture.reset();
  await assert.rejects(
    driver.transaction(async (transaction) => {
      const claimed = await driver.claimIdempotency(transaction, {
        lifecycle: fixture.transition.lifecycle,
        resourceId: fixture.transition.resourceId,
        key: "owner-rollback",
        fingerprint: "same",
        createdAt: fixture.transition.occurredAt,
      });
      assert.equal(claimed.status, "claimed");
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await assert.rejects(
    driver.transaction(async (transaction) => {
      const claimed = await driver.claimIdempotency(transaction, {
        lifecycle: fixture.transition.lifecycle,
        resourceId: fixture.transition.resourceId,
        key: "owner-rollback",
        fingerprint: "same",
        createdAt: fixture.transition.occurredAt,
      });
      assert.equal(
        claimed.status,
        "claimed",
        "rollback releases the unique claim",
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
}
