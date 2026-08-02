import assert from "node:assert/strict";
import type {
  ResourceBinding,
  TransactionDriver,
  TransactionOptions,
  VersionToken,
} from "@interlock/core";

export interface BindingConformance<Transaction, Resource, Mutation, Context> {
  driver: TransactionDriver<Transaction>;
  binding: ResourceBinding<Transaction, Resource, Mutation, Context>;
  reset(): Promise<void>;
  id: string;
  event: string;
  fromState: string;
  toState: string;
  expectedVersion: VersionToken;
  staleVersion: VersionToken;
  nextVersion: VersionToken;
  invalidSourceState: string;
  mutation: Mutation;
  advisoryOptions: TransactionOptions;
  authoritativeOptions: TransactionOptions;
  assertContext(
    context: Context,
    mode: "advisory" | "authoritative",
  ): Promise<void>;
  relatedCount?(): Promise<number>;
  expectedRelatedCount?: number;
  assertRelated?(): Promise<void>;
}

export async function verifyResourceBinding<
  Transaction,
  Resource,
  Mutation,
  Context,
>(
  fixture: BindingConformance<Transaction, Resource, Mutation, Context>,
): Promise<void> {
  const { binding, driver } = fixture;
  assert.deepEqual(
    binding.transactionOptions({ mode: "advisory", event: fixture.event }),
    fixture.advisoryOptions,
  );
  assert.deepEqual(
    binding.transactionOptions({ mode: "authoritative", event: fixture.event }),
    fixture.authoritativeOptions,
  );

  await fixture.reset();
  await driver.transaction(async (transaction) => {
    const resource = await binding.loadPrimary(transaction, fixture.id);
    assert.ok(resource);
    assert.equal(binding.getId(resource), fixture.id);
    assert.equal(binding.getState(resource), fixture.fromState);
    assert.equal(binding.getVersion(resource), fixture.expectedVersion);
    await fixture.assertContext(
      binding.contextFactory.create(transaction, {
        mode: "advisory",
        event: fixture.event,
      }),
      "advisory",
    );
    await fixture.assertContext(
      binding.contextFactory.create(transaction, {
        mode: "authoritative",
        event: fixture.event,
      }),
      "authoritative",
    );
    const applied = await binding.applyPrimary(transaction, {
      resource,
      fromState: fixture.fromState,
      toState: fixture.toState,
      expectedVersion: fixture.expectedVersion,
      nextVersion: fixture.nextVersion,
      mutation: fixture.mutation,
    });
    assert.equal(applied.status, "applied");
    if (applied.status !== "applied") return;
    assert.equal(binding.getId(applied.resource), fixture.id);
    assert.equal(binding.getState(applied.resource), fixture.toState);
    assert.equal(binding.getVersion(applied.resource), fixture.nextVersion);
    await binding.applyRelated?.(transaction, {
      previousResource: resource,
      updatedResource: applied.resource,
      mutation: fixture.mutation,
      transitionId: "binding-conformance",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    if (binding.hydrateBeforeCommit) {
      const hydrated = await binding.hydrateBeforeCommit(
        transaction,
        applied.resource,
      );
      assert.equal(binding.getId(hydrated), fixture.id);
      assert.equal(binding.getState(hydrated), fixture.toState);
      assert.equal(binding.getVersion(hydrated), fixture.nextVersion);
    }
  });
  if (fixture.assertRelated) await fixture.assertRelated();
  else if (fixture.relatedCount)
    assert.equal(
      await fixture.relatedCount(),
      fixture.expectedRelatedCount ?? (binding.applyRelated ? 1 : 0),
    );

  await fixture.reset();
  await driver.transaction(async (transaction) => {
    const resource = await binding.loadPrimary(transaction, fixture.id);
    assert.ok(resource);
    const stale = await binding.applyPrimary(transaction, {
      resource,
      fromState: fixture.fromState,
      toState: fixture.toState,
      expectedVersion: fixture.staleVersion,
      nextVersion: fixture.nextVersion,
      mutation: fixture.mutation,
    });
    assert.equal(stale.status, "conflict");
  });

  await fixture.reset();
  await driver.transaction(async (transaction) => {
    const resource = await binding.loadPrimary(transaction, fixture.id);
    assert.ok(resource);
    const invalidState = await binding.applyPrimary(transaction, {
      resource,
      fromState: fixture.invalidSourceState,
      toState: fixture.toState,
      expectedVersion: fixture.expectedVersion,
      nextVersion: fixture.nextVersion,
      mutation: fixture.mutation,
    });
    assert.equal(invalidState.status, "conflict");
  });
}
