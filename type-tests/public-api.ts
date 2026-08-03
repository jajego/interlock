import {
  createInterlock,
  defineEvent,
  defineLifecycle,
  noInput,
  primaryRowOnly,
  type BindingFor,
  type ClientFor,
  type InputSchema,
  type InterlockClient,
  type InterlockObservation,
  type InterlockObserver,
  type MutationMap,
  type PublicDenial,
  type ResourceBinding,
  type TransactionDriver,
} from "../packages/core/src/index.js";
// @ts-expect-error executor-only JSON snapshotting is not public
import { snapshotJsonValue } from "../packages/core/src/index.js";
// @ts-expect-error executor lifecycle maps are not public
import type { EventMap as InternalEventMap } from "../packages/core/src/index.js";
void snapshotJsonValue;
declare const accidentalExport: InternalEventMap;
void accidentalExport;

interface Resource {
  id: string;
  state: string;
  version: string;
}
interface Actor {
  id: string;
  tenantId: string;
}
interface Context {
  tenantId: string;
}

const reasonSchema: InputSchema<{ reason: string }, { reason: string }> = {
  parse(input) {
    return typeof input === "object" && input !== null && "reason" in input
      ? { success: true, value: { reason: String(input.reason) } }
      : { success: false, issues: [] };
  },
};
const event = defineEvent<Resource, Actor, Context>();

const lifecycle = defineLifecycle<Resource, Actor, Context>()({
  name: "typed",
  states: ["open", "approved", "rejected", "archived"],
  history: { resourceType: "item" },
  events: {
    approve: event(noInput, {
      from: ["open"],
      to: "approved",
      mutate: ({ actor, operation }) => ({
        approvedBy: actor.id,
        correlationId: operation.correlationId,
      }),
    }),
    reject: event(reasonSchema, {
      from: ["open"],
      to: "rejected",
      mutate: ({ input }) => ({ reason: input.reason }),
    }),
    archive: event({ from: ["approved", "rejected"], to: "archived" }),
  },
});

declare const driver: TransactionDriver<object>;

const observer: InterlockObserver = {
  observe(observation) {
    switch (observation.type) {
      case "interlock.operation.started":
        void observation.operationId;
        // @ts-expect-error started observations have no outcome
        void observation.outcome;
        // @ts-expect-error raw input is never observed
        void observation.input;
        break;
      case "interlock.operation.completed":
        void observation.outcome;
        void observation.transitionId;
        void observation.outboxMessageCount;
        // @ts-expect-error completed observations have no error code
        void observation.code;
        // @ts-expect-error resources are never observed
        void observation.resource;
        break;
      case "interlock.operation.failed":
        void observation.code;
        void observation.phase;
        void observation.commitOutcome;
        // @ts-expect-error raw errors are never observed
        void observation.error;
        // @ts-expect-error payloads are never observed
        void observation.payload;
        break;
      default: {
        const exhaustive: never = observation;
        void exhaustive;
      }
    }
  },
};
declare const observation: InterlockObservation;
void observation.lifecycle;

const binding: BindingFor<object, typeof lifecycle> = {
  loadPrimary: async (_transaction, operation) => {
    void operation.actor.tenantId;
    void operation.id;
    return null;
  },
  getId: (resource) => resource.id,
  getState: (resource) => resource.state,
  getVersion: (resource) => resource.version,
  contextFactory: {
    create: (_transaction, operation) => ({
      tenantId: operation.actor.tenantId,
    }),
  },
  applyPrimary: async (_transaction, args) => {
    switch (args.operation.event) {
      case "approve":
        void args.operation.mutation.approvedBy;
        // @ts-expect-error reject mutation cannot appear on approve
        void args.operation.mutation.reason;
        break;
      case "reject":
        void args.operation.mutation.reason;
        // @ts-expect-error approve mutation cannot appear on reject
        void args.operation.mutation.approvedBy;
        break;
      case "archive":
        void (args.operation.mutation satisfies undefined);
        break;
      default: {
        const exhaustive: never = args.operation;
        void exhaustive;
      }
    }
    return { status: "conflict" };
  },
  consistency: primaryRowOnly,
};

const client = createInterlock({ lifecycle, binding, driver, observer });
const named: InterlockClient<Resource, Actor, typeof lifecycle.events> = client;
const derived: ClientFor<typeof lifecycle> = client;
void derived;

named.transition({
  id: "item-1",
  event: "approve",
  actor: { id: "user-1", tenantId: "tenant-1" },
  expectedVersion: "1",
});
named.transition({
  id: "item-1",
  event: "reject",
  input: { reason: "duplicate" },
  actor: { id: "user-1", tenantId: "tenant-1" },
  expectedVersion: "1",
});
named.transition({
  id: "item-1",
  event: "archive",
  actor: { id: "user-1", tenantId: "tenant-1" },
  expectedVersion: "1",
});
// @ts-expect-error reject input is required
named.transition({
  id: "item-1",
  event: "reject",
  actor: { id: "user-1", tenantId: "tenant-1" },
  expectedVersion: "1",
});
named.transition({
  id: "item-1",
  event: "approve",
  // @ts-expect-error no-input event rejects input
  input: {},
  actor: { id: "user-1", tenantId: "tenant-1" },
  expectedVersion: "1",
});

const minimalLifecycle = defineLifecycle<Resource>()({
  name: "minimal",
  states: ["open", "closed"],
  history: { resourceType: "item" },
  events: {
    close: defineEvent<Resource>()({ from: ["open"], to: "closed" }),
  },
});
declare const noMutation: MutationMap<{
  close: { from: readonly ["open"]; to: "closed" };
}>["close"];
void (noMutation satisfies undefined);
void minimalLifecycle;
const minimalBinding: ResourceBinding<
  object,
  Resource,
  undefined,
  undefined,
  MutationMap<typeof minimalLifecycle.events>
> = {
  loadPrimary: async () => null,
  getId: (resource) => resource.id,
  getState: (resource) => resource.state,
  getVersion: (resource) => resource.version,
  applyPrimary: async () => ({ status: "conflict" }),
  consistency: primaryRowOnly,
};
void minimalBinding;
const minimalClient = createInterlock({
  lifecycle: minimalLifecycle,
  binding: minimalBinding,
  driver,
});
minimalClient.transition({
  id: "item-1",
  event: "close",
  expectedVersion: "1",
});
minimalClient.transition({
  id: "item-1",
  event: "close",
  expectedVersion: "1",
  // @ts-expect-error lifecycle does not define an idempotency fingerprint
  idempotency: { key: "close-1" },
});

const idempotentLifecycle = defineLifecycle<Resource>()({
  name: "idempotent",
  states: ["open", "closed"],
  history: { resourceType: "item" },
  idempotency: {
    fingerprint: ({ resourceId, event }) => `${resourceId}:${event}`,
  },
  events: {
    close: defineEvent<Resource>()({ from: ["open"], to: "closed" }),
  },
});

const discriminatedFingerprintLifecycle = defineLifecycle<Resource>()({
  name: "fingerprint-inputs",
  states: ["open", "closed", "rejected"],
  history: { resourceType: "item" },
  idempotency: {
    fingerprint: (args) => {
      switch (args.event) {
        case "close":
          void (args.parsedInput satisfies undefined);
          break;
        case "reject":
          void args.parsedInput.reason;
          break;
        default: {
          const exhaustive: never = args;
          void exhaustive;
        }
      }
      return `${args.resourceId}:${args.event}`;
    },
  },
  events: {
    close: defineEvent<Resource>()(noInput, {
      from: ["open"],
      to: "closed",
    }),
    reject: defineEvent<Resource>()(reasonSchema, {
      from: ["open"],
      to: "rejected",
    }),
  },
});
void discriminatedFingerprintLifecycle;
declare const idempotentBinding: BindingFor<object, typeof idempotentLifecycle>;
const idempotentClient = createInterlock({
  lifecycle: idempotentLifecycle,
  binding: idempotentBinding,
  driver,
});
idempotentClient.transition({
  id: "item-1",
  event: "close",
  expectedVersion: "1",
  idempotency: { key: "close-1" },
});

defineLifecycle<Resource>()({
  name: "invalid-state",
  states: ["open", "closed"],
  history: { resourceType: "item" },
  events: {
    // @ts-expect-error event source must be a declared lifecycle state
    close: defineEvent<Resource>()({
      from: ["typo"],
      to: "closed",
    }),
  },
});

const safeDenial: PublicDenial = {
  source: "guard",
  code: "MISSING_DOCUMENTS",
  publicDetails: { documentTypes: ["identity"] },
};
void safeDenial;
const unsafeDenial: PublicDenial = {
  source: "guard",
  code: "BAD",
  // @ts-expect-error public details must be JSON-safe
  publicDetails: { createdAt: new Date() },
};
void unsafeDenial;
