import test from "node:test";
import assert from "node:assert/strict";
import { InterlockError } from "../packages/core/dist/index.js";
import {
  barrier,
  verifyExecutorAtomicity,
  verifyResourceBinding,
} from "../packages/conformance/dist/index.js";

function memoryDriver(state) {
  return {
    transaction: async (operation) => {
      const before = JSON.parse(JSON.stringify(state));
      try {
        return await operation({});
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
    claimIdempotency: async () => ({ status: "claimed", claim: {} }),
    completeIdempotency: async () => undefined,
    insertTransition: async () => undefined,
    insertOutbox: async () => undefined,
  };
}

test("executor conformance preserves arbitrary fixture baselines", async () => {
  const state = {};
  const driver = memoryDriver(state);
  await verifyExecutorAtomicity({
    driver,
    reset: async () =>
      Object.assign(state, {
        primaryVersion: "41",
        related: 3,
        history: 5,
        outbox: 7,
        idempotency: 11,
      }),
    transition: (candidate) =>
      candidate.transaction(async (transaction) => {
        state.primaryVersion = "42";
        try {
          await candidate.insertTransition(transaction, {});
        } catch (cause) {
          throw new InterlockError(
            "INTERLOCK_HISTORY_FAILED",
            "History failed.",
            { cause },
          );
        }
        state.history += 1;
        try {
          await candidate.insertOutbox(transaction, [{}]);
        } catch (cause) {
          throw new InterlockError(
            "INTERLOCK_OUTBOX_FAILED",
            "Outbox failed.",
            { cause },
          );
        }
        state.outbox += 1;
        try {
          await candidate.completeIdempotency(transaction, {});
        } catch (cause) {
          throw new InterlockError(
            "INTERLOCK_PERSISTENCE_FAILED",
            "Completion failed.",
            { cause },
          );
        }
        state.idempotency += 1;
      }),
    snapshot: async () => ({ ...state }),
  });
});

async function verifyMemoryBinding(relatedWrites, hydrate = false) {
  const state = { resource: undefined, related: 0 };
  const driver = memoryDriver(state);
  const binding = {
    transactionOptions: ({ mode }) => ({ readOnly: mode === "advisory" }),
    loadPrimary: async () => state.resource,
    getId: (resource) => resource.id,
    getState: (resource) => resource.state,
    getVersion: (resource) => resource.version,
    applyPrimary: async (_transaction, args) => {
      if (
        args.fromState !== state.resource.state ||
        args.expectedVersion !== state.resource.version
      )
        return { status: "conflict" };
      state.resource = {
        ...state.resource,
        state: args.toState,
        version: args.nextVersion,
      };
      return { status: "applied", resource: state.resource };
    },
    contextFactory: { create: () => ({ ready: true }) },
    ...(relatedWrites
      ? {
          applyRelated: async () => {
            state.related += relatedWrites;
          },
        }
      : {}),
    ...(hydrate
      ? {
          hydrateBeforeCommit: async (_transaction, args) => ({
            ...args.resource,
          }),
        }
      : {}),
  };
  await verifyResourceBinding({
    driver,
    binding,
    reset: async () => {
      state.resource = { id: "r1", state: "open", version: "7" };
      state.related = 0;
    },
    id: "r1",
    event: "close",
    actor: undefined,
    fromState: "open",
    toState: "closed",
    expectedVersion: "7",
    staleVersion: "6",
    nextVersion: "8",
    invalidSourceState: "other",
    mutation: {},
    advisoryOptions: { readOnly: true },
    authoritativeOptions: { readOnly: false },
    assertContext: async (context) => assert.equal(context.ready, true),
    relatedCount: async () => state.related,
    expectedRelatedCount: relatedWrites,
  });
}

test("binding conformance supports zero related writes", async () => {
  await verifyMemoryBinding(0);
});

test("binding conformance supports multiple related writes", async () => {
  await verifyMemoryBinding(2);
});

test("binding conformance verifies in-transaction hydration", async () => {
  await verifyMemoryBinding(0, true);
});

test("barriers release every waiter only after reaching capacity", async () => {
  const wait = barrier(2);
  let released = false;
  const first = wait().then(() => {
    released = true;
  });
  await Promise.resolve();
  assert.equal(released, false);
  await wait();
  await first;
  assert.equal(released, true);
});
