import {
  createInterlock,
  defineEvent,
  defineLifecycle,
  noInput,
  primaryRowOnly,
  type OutboxInsert,
  type TransactionDriver,
  type TransitionRecord,
} from "@jajego/interlock";
import { environment, measure } from "./report.js";

type Resource = { id: string; state: string; version: string };
type Transaction = object;

type ObserverKind = "none" | "noop" | "counter" | "promise";

function client(options: {
  guards: number;
  outbox: number;
  bytes: number;
  observer?: ObserverKind;
}) {
  const payload = { value: "x".repeat(Math.max(0, options.bytes - 12)) };
  const lifecycle = defineLifecycle<Resource>()({
    name: "cpu",
    states: ["a", "b"],
    history: { resourceType: "probe" },
    idempotency: {
      fingerprint: ({ resourceId, event, expectedVersion }) =>
        `${resourceId}:${event}:${expectedVersion}`,
    },
    events: {
      move: defineEvent<Resource>()(noInput, {
        from: ["a"],
        to: "b",
        authorize: () => true,
        guards: Array.from({ length: options.guards }, (_, index) => ({
          name: `guard-${index}`,
          evaluate: () => true,
        })),
        audit: () => payload,
        outbox: ({ resource }) =>
          Array.from({ length: options.outbox }, (_, index) => ({
            topic: `probe.${index}`,
            key: resource.id,
            payload,
          })),
      }),
    },
  });
  let stored: TransitionRecord | undefined;
  const driver: TransactionDriver<Transaction> = {
    transaction: (operation) => operation({}),
    claimIdempotency: async (_transaction, claim) =>
      stored && stored.idempotencyKey === claim.key
        ? { status: "duplicate", transition: stored }
        : { status: "claimed" },
    completeIdempotency: async () => {},
    insertTransition: async (transaction, value) => {
      void transaction;
      stored = value;
    },
    insertOutbox: async (transaction, messages: readonly OutboxInsert[]) => {
      void transaction;
      void messages;
    },
  };
  let observed = 0;
  const observer =
    options.observer === "noop"
      ? { observe: () => {} }
      : options.observer === "counter"
        ? {
            observe: () => {
              observed += 1;
            },
          }
        : options.observer === "promise"
          ? { observe: () => Promise.resolve() }
          : undefined;
  const subject = createInterlock({
    lifecycle,
    driver,
    binding: {
      loadPrimary: async () => ({ id: "resource", state: "a", version: "1" }),
      getId: (resource) => resource.id,
      getState: (resource) => resource.state,
      getVersion: (resource) => resource.version,
      applyPrimary: async (_transaction, args) => ({
        status: "applied",
        resource: { ...args.resource, state: "b", version: "2" },
      }),
      consistency: primaryRowOnly,
    },
    ids: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
    ...(observer ? { observer } : {}),
  });
  void observed;
  return subject;
}

const scenarios = [
  ["minimal-non-idempotent", 0, 0, 0, false],
  ["idempotent-first", 0, 0, 0, true],
  ["guards-1", 1, 0, 0, false],
  ["guards-5", 5, 0, 0, false],
  ["outbox-1", 0, 1, 0, false],
  ["outbox-5", 0, 5, 0, false],
  ["json-1kb", 0, 1, 1_024, false],
  ["json-64kb", 0, 1, 65_536, false],
] as const;
const reports = [];
for (const [name, guards, outbox, bytes, idempotent] of scenarios) {
  const subject = client({ guards, outbox, bytes });
  reports.push(
    await measure(name, async (iteration) => ({
      run: async () => {
        const result = await subject.transition({
          id: "resource",
          event: "move",
          actor: undefined,
          expectedVersion: "1",
          ...(idempotent
            ? { idempotency: { key: `${name}-${iteration}` } }
            : {}),
        });
        if (result.status !== "committed") throw new Error(result.status);
      },
    })),
  );
}
for (const observer of ["none", "noop", "counter", "promise"] as const) {
  const subject = client({ guards: 0, outbox: 0, bytes: 0, observer });
  reports.push(
    await measure(
      `observer-${observer}`,
      async () => ({
        run: async () => {
          const result = await subject.transition({
            id: "resource",
            event: "move",
            expectedVersion: "1",
          });
          if (result.status !== "committed") throw new Error(result.status);
        },
      }),
      { warmups: 100, iterations: 1_000, rounds: 5 },
    ),
  );
}
const duplicate = client({ guards: 0, outbox: 1, bytes: 0 });
const duplicateRequest = {
  id: "resource",
  event: "move" as const,
  actor: undefined,
  expectedVersion: "1",
  idempotency: { key: "duplicate" },
};
await duplicate.transition(duplicateRequest);
reports.push(
  await measure("duplicate-replay", async () => ({
    run: async () => {
      const result = await duplicate.transition(duplicateRequest);
      if (result.status !== "committed" || !result.duplicate)
        throw new Error(result.status);
    },
  })),
);
process.stdout.write(
  `${JSON.stringify({ layer: "orchestration-cpu", environment: environment(), reports }, null, 2)}\n`,
);
