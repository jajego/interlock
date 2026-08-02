import assert from "node:assert/strict";
import type {
  ResourceBinding,
  InterlockOperation,
  TransactionDriver,
  TransactionOptions,
  VersionToken,
} from "@interlock/core";

export interface BindingConformance<
  Transaction,
  Resource,
  Actor,
  Mutation,
  Context,
> {
  driver: TransactionDriver<Transaction>;
  binding: ResourceBinding<
    Transaction,
    Resource,
    Actor,
    Context,
    Record<string, Mutation>
  >;
  reset(): Promise<void>;
  id: string;
  event: string;
  actor: Actor;
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
  Actor,
  Mutation,
  Context,
>(
  fixture: BindingConformance<Transaction, Resource, Actor, Mutation, Context>,
): Promise<void> {
  const { binding, driver } = fixture;
  const operation = (mode: "advisory" | "authoritative") =>
    Object.freeze({
      mode,
      id: fixture.id,
      event: fixture.event,
      actor: fixture.actor,
    }) satisfies InterlockOperation<Actor>;
  assert.deepEqual(
    binding.transactionOptions?.(operation("advisory")) ?? {},
    fixture.advisoryOptions,
  );
  assert.deepEqual(
    binding.transactionOptions?.(operation("authoritative")) ?? {},
    fixture.authoritativeOptions,
  );

  await fixture.reset();
  await driver.transaction(async (transaction) => {
    const resource = await binding.loadPrimary(
      transaction,
      operation("authoritative"),
    );
    assert.ok(resource);
    assert.equal(binding.getId(resource), fixture.id);
    assert.equal(binding.getState(resource), fixture.fromState);
    assert.equal(binding.getVersion(resource), fixture.expectedVersion);
    if (binding.contextFactory) {
      await fixture.assertContext(
        await binding.contextFactory.create(transaction, operation("advisory")),
        "advisory",
      );
      await fixture.assertContext(
        await binding.contextFactory.create(
          transaction,
          operation("authoritative"),
        ),
        "authoritative",
      );
    }
    const applied = await binding.applyPrimary(transaction, {
      resource,
      fromState: fixture.fromState,
      toState: fixture.toState,
      expectedVersion: fixture.expectedVersion,
      nextVersion: fixture.nextVersion,
      operation: { ...operation("authoritative"), mutation: fixture.mutation },
    });
    assert.equal(applied.status, "applied");
    if (applied.status !== "applied") return;
    assert.equal(binding.getId(applied.resource), fixture.id);
    assert.equal(binding.getState(applied.resource), fixture.toState);
    assert.equal(binding.getVersion(applied.resource), fixture.nextVersion);
    await binding.applyRelated?.(transaction, {
      previousResource: resource,
      updatedResource: applied.resource,
      operation: { ...operation("authoritative"), mutation: fixture.mutation },
      transitionId: "binding-conformance",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    if (binding.hydrateBeforeCommit) {
      const hydrated = await binding.hydrateBeforeCommit(transaction, {
        resource: applied.resource,
        operation: {
          ...operation("authoritative"),
          mutation: fixture.mutation,
        },
      });
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
    const resource = await binding.loadPrimary(
      transaction,
      operation("authoritative"),
    );
    assert.ok(resource);
    const stale = await binding.applyPrimary(transaction, {
      resource,
      fromState: fixture.fromState,
      toState: fixture.toState,
      expectedVersion: fixture.staleVersion,
      nextVersion: fixture.nextVersion,
      operation: { ...operation("authoritative"), mutation: fixture.mutation },
    });
    assert.equal(stale.status, "conflict");
  });

  await fixture.reset();
  await driver.transaction(async (transaction) => {
    const resource = await binding.loadPrimary(
      transaction,
      operation("authoritative"),
    );
    assert.ok(resource);
    const invalidState = await binding.applyPrimary(transaction, {
      resource,
      fromState: fixture.invalidSourceState,
      toState: fixture.toState,
      expectedVersion: fixture.expectedVersion,
      nextVersion: fixture.nextVersion,
      operation: { ...operation("authoritative"), mutation: fixture.mutation },
    });
    assert.equal(invalidState.status, "conflict");
  });
}
