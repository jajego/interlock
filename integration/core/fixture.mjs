import {
  createInterlock,
  defineLifecycle,
} from "../../packages/core/dist/index.js";

export function executorFixture(options = {}) {
  const order = [];
  let inserted;
  let insertedOutbox;
  let claimed;
  const driver = {
    transaction: (operation, transactionOptions) => {
      options.observeTransactionOptions?.(transactionOptions);
      return operation({});
    },
    claimIdempotency: async (_transaction, claim) => {
      order.push("claim");
      claimed = claim;
      return (
        options.claimCallback?.(claim) ??
        options.claim ?? { status: "claimed", claim }
      );
    },
    completeIdempotency: async () => {
      order.push("complete");
      return options.complete?.();
    },
    insertTransition: async (_transaction, value) => {
      order.push("history");
      inserted = value;
      return options.insertTransition?.(value);
    },
    insertOutbox: async (_transaction, messages) => {
      order.push("outbox");
      insertedOutbox = messages;
      return options.insertOutbox?.(messages);
    },
  };
  const definition = {
    name: "item",
    states: ["a", "b"],
    history: {
      resourceType: "item",
      actor: (actor) =>
        typeof options.actorCallback === "function"
          ? options.actorCallback(actor)
          : (options.actorIdentity ?? {}),
      metadata: (args) => {
        order.push("metadata");
        return options.metadataCallback?.(args) ?? options.metadata ?? {};
      },
    },
    definitionVersion: options.definitionVersion,
    ...(options.omitIdempotency
      ? {}
      : {
          idempotency: {
            fingerprint: (...args) =>
              typeof options.fingerprintCallback === "function"
                ? options.fingerprintCallback(...args)
                : "fingerprint",
          },
        }),
    events: {
      move: {
        from: ["a"],
        to: "b",
        input: options.input,
        authorize: (args) => {
          order.push("authorize");
          return options.authorize?.(args) ?? { allowed: true };
        },
        guards: options.guards,
        ...(options.noMutation
          ? {}
          : {
              mutate: (args) => {
                order.push("mutate");
                return options.mutate?.(args) ?? {};
              },
            }),
        audit: options.audit,
        outbox: options.outbox,
      },
    },
  };
  const binding = {
    ...(options.omitTransactionOptions
      ? {}
      : {
          transactionOptions: (args) =>
            options.transactionOptionsCallback?.(args) ??
            options.transactionOptions ??
            {},
        }),
    loadPrimary: async (...args) =>
      typeof options.loadPrimary === "function"
        ? options.loadPrimary(...args)
        : {
            id: options.loadedId ?? "item-1",
            state: "a",
            version: "1",
          },
    getId: options.bindingAccessors?.getId ?? ((resource) => resource.id),
    getState:
      options.bindingAccessors?.getState ?? ((resource) => resource.state),
    getVersion:
      options.bindingAccessors?.getVersion ?? ((resource) => resource.version),
    applyPrimary: async (_transaction, args) => {
      order.push("apply");
      options.observeApply?.(args);
      return (
        (await options.applyPrimary?.(args)) ??
        options.applied ?? {
          status: "applied",
          resource: {
            ...args.resource,
            state: args.toState,
            version: args.nextVersion,
          },
        }
      );
    },
    applyRelated: options.applyRelated,
    hydrateBeforeCommit: options.hydrate,
    ...(options.omitContext
      ? {}
      : {
          contextFactory: {
            create: (...args) => options.context?.(...args) ?? {},
          },
        }),
    consistency: options.consistency ?? {
      strategy: "none",
      notes: "fixture",
    },
  };
  const clocks = [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:00:01.000Z"),
  ];
  const subject = createInterlock({
    lifecycle: defineLifecycle()(definition),
    driver: options.driver ?? driver,
    binding,
    now:
      options.now ??
      (() => {
        order.push("clock");
        return clocks.shift();
      }),
    ids: options.ids ?? (() => "transition-1"),
    maxOutboxPayloadBytes: options.maxOutboxPayloadBytes,
  });
  return {
    subject,
    order,
    getTransition: () => inserted,
    getOutbox: () => insertedOutbox,
    getClaim: () => claimed,
  };
}

export const transitionRequest = {
  id: "item-1",
  event: "move",
  actor: undefined,
  expectedVersion: "1",
  idempotency: { key: "key" },
};

export const validDuplicate = {
  id: "original-transition",
  lifecycle: "item",
  resourceType: "item",
  resourceId: "item-1",
  event: "move",
  fromState: "a",
  toState: "b",
  previousVersion: "1",
  nextVersion: "2",
  idempotencyKey: "key",
  requestFingerprint: "fingerprint",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
};
