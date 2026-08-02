import {
  createInterlock,
  defineEvent,
  defineLifecycle,
  noInput,
  primaryRowOnly,
  type InputSchema,
  type InterlockClient,
  type MutationMap,
  type PublicDenial,
  type ResourceBinding,
  type TransactionDriver,
  type VersionToken,
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
  version: VersionToken;
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
      mutate: ({ actor }) => ({ approvedBy: actor.id }),
    }),
    reject: event(reasonSchema, {
      from: ["open"],
      to: "rejected",
      mutate: ({ input }) => ({ reason: input.reason }),
    }),
    archive: event({ from: ["approved", "rejected"], to: "archived" }),
  },
});

type Mutations = MutationMap<typeof lifecycle.events>;
declare const driver: TransactionDriver<object>;

const binding: ResourceBinding<object, Resource, Actor, Context, Mutations> = {
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

const client = createInterlock({ lifecycle, binding, driver });
const named: InterlockClient<Resource, Actor, typeof lifecycle.events> = client;

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
