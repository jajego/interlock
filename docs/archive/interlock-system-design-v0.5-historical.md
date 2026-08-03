# Historical Interlock system design v0.5

> **Superseded:** This proposal does not describe the current public API. It is
> retained only as design history. Use the root `README.md`,
> `docs/architecture.md`, current code, and tests for `0.1.0-alpha.0`.

# Interlock

## A Type-Safe Transaction Protocol for Domain Transitions on Persisted Records

**Status:** Design proposal
**Document version:** 0.5
**Working project name:** Interlock
**Initial packages:** `@jajego/interlock`, `@jajego/interlock-postgres`, and `@jajego/interlock-conformance`
**Initial database target:** PostgreSQL
**Recommended license:** Apache-2.0

---

## 1. Executive summary

Business applications frequently contain persisted resources that move through explicit domain states:

- an application moves from `draft` to `submitted`;
- a permit moves from `under_review` to `approved`;
- an invoice moves from `open` to `paid`;
- a report moves from `queued` to `generated`;
- an account moves from `active` to `suspended`;
- an article moves from `draft` to `published`.

These transitions often begin as simple status updates. Over time, they accumulate input validation, authorization, domain prerequisites, concurrency control, audit requirements, request idempotency, related database writes, and reliable outbound events.

Interlock provides a narrowly scoped TypeScript protocol for applying a domain event to an ordinary application-owned PostgreSQL record.

```ts
const result = await applications.transition({
  id: applicationId,
  event: "approve",
  input: {
    note: "All requirements satisfied.",
  },
  actor: currentUser,
  expectedVersion: "7",
  idempotency: {
    key: request.headers["idempotency-key"],
  },
});
```

For a successful transition, Interlock guarantees that these writes either commit together or do not happen:

1. the version-checked primary-resource update;
2. the immutable transition-history record;
3. the idempotency completion record;
4. declared transactional-outbox messages;
5. application-defined related writes executed through the same transaction.

Interlock also ensures that:

- the event is known;
- request input is parsed and validated before execution;
- the current resource state permits the event;
- authorization passes;
- domain guards pass;
- concurrent primary-resource changes are detected;
- retries with the same idempotency key resolve according to an explicit concurrent protocol.

Interlock is not a generic state-machine runtime, durable workflow engine, actor system, ORM, authorization language, event store, queue, scheduler, or hosted service.

Its core proposition is:

> Interlock applies a domain command, its version-checked resource update, its related writes, its transition history, its idempotency outcome, and its outbox messages as one database transaction.

---

## 2. Product positioning

### 2.1 One-sentence description

**Interlock provides type-safe, atomic domain transitions for database records.**

### 2.2 Architectural description

Interlock is an ORM-neutral transaction protocol for applying domain events to persisted resources.

### 2.3 What it competes on

Interlock does not compete on state-graph expressiveness. States, typed events, guards, advisory transition checks, graph inspection, and visualization already exist in mature libraries and newer persistence frameworks.

Interlock competes on the commit protocol:

```text
domain event
    +
validated and normalized event input
    +
authorization and guards
    +
expected resource version
    +
conditional primary-resource update
    +
immutable transition history
    +
request idempotency
    +
optional outbox messages
    =
one atomic database operation
```

### 2.4 Appropriate use cases

Interlock is appropriate when state changes are:

- business-significant;
- permission-sensitive;
- subject to prerequisites;
- likely to be audited;
- vulnerable to concurrent updates;
- invoked from multiple code paths;
- expected to request reliable downstream work.

Typical resources include applications, permits, orders, invoices, subscriptions, reports, support cases, listings, documents, user accounts, review decisions, content publications, and deployment records.

### 2.5 Poor use cases

Interlock is not appropriate for component interaction state, animations, loading indicators, form-wizard UI state, long-running workflows, delayed tasks, distributed sagas, parallel or hierarchical statecharts, event-sourced aggregates, high-frequency telemetry, or simple unrestricted boolean toggles.

---

## 3. Ecosystem boundary

### 3.1 State-machine and statechart libraries

Libraries such as XState provide advanced state semantics including actors, hierarchical states, parallel regions, invoked services, delayed transitions, graph analysis, and frontend or backend runtime behavior.

Interlock deliberately does not reproduce those semantics. A Interlock lifecycle is finite and shallow:

- no hierarchical states;
- no parallel states;
- no actors;
- no delayed transitions;
- no invoked child machines;
- no continuously running state-machine process.

Interlock's graph exists to constrain database commands, not to model an executing actor.

### 3.2 Durable workflow systems

Temporal, Restate, Inngest, Trigger.dev, and similar systems provide resumable execution, timers, retry policies, worker runtimes, distributed task coordination, and external signals.

Interlock does not suspend or resume code. A transition should complete within one application database transaction. Long-running work is requested through an outbox message and executed elsewhere.

### 3.3 Persistence frameworks with transition APIs

Some persistence frameworks already provide typed transition payloads, guards, advisory `can*` methods, and compare-and-swap writes. That significantly overlaps with Interlock's surface ergonomics.

Interlock remains distinct only if it stays centered on:

- application-owned records;
- an explicit executor-owned commit protocol;
- immutable transition history;
- concurrent request idempotency;
- transactional outbox insertion;
- explicit transaction-driver and resource-binding contracts;
- no required Active Record model or broad persistence framework.

Typed guards plus optimistic locking are not sufficient differentiation.

### 3.4 Authorization systems

Authorization systems answer whether an actor may perform an action. Interlock does not define an authorization language. It invokes an application-provided authorization function during assessment.

### 3.5 Event sourcing

Interlock is not event sourcing. The primary resource row remains authoritative. Transition rows are audit and integration records, not a replay log required to reconstruct current state.

### 3.6 Closest conceptual predecessors

Statesman is important prior art for persisted transition history, model separation, metadata, and integrity protections. Other workflow and persistence plugins overlap with typed guards, hierarchical workflows, or compare-and-swap state writes. Outbox and idempotency libraries overlap with Interlock's infrastructure concerns.

Interlock's intended differentiation is the reusable combination of:

- TypeScript-native event input inference;
- application-owned authoritative records;
- explicit numeric version counters represented safely as strings;
- structured denial results;
- same-transaction concurrent idempotency;
- immutable transition history;
- transactional outbox insertion;
- transaction-driver conformance;
- resource-binding verification;
- executor-level atomicity tests.

Interlock should acknowledge prior art openly and avoid novelty claims about individual components.

---

## 4. Problem statement

A transition often begins as a simple service function:

```ts
async function approveApplication(id: string) {
  const application = await db.application.findUniqueOrThrow({
    where: { id },
  });

  if (application.status !== "under_review") {
    throw new Error("Application cannot be approved");
  }

  return db.application.update({
    where: { id },
    data: {
      status: "approved",
      approvedAt: new Date(),
    },
  });
}
```

A production implementation may later need:

- event-specific input parsing;
- actor authorization;
- domain guards;
- state and version predicates;
- related writes;
- immutable history;
- retry-safe idempotency;
- outbox insertion;
- structured expected outcomes;
- transaction isolation rules;
- fault and race testing.

The service implementation can remain correct, but its semantics are easy to reproduce inconsistently across REST handlers, GraphQL resolvers, jobs, scripts, administrative interfaces, webhook handlers, migrations, and test fixtures.

Common failures include:

- one code path directly updating the state column;
- an administrative endpoint skipping a guard;
- two requests acting on the same stale version;
- history or outbox writes occurring outside the resource transaction;
- retrying a committed request and applying it twice;
- an idempotency lookup that races;
- raw sensitive input being copied into audit history;
- assuming that related rows read by guards remain stable until commit;
- a post-commit reload failure obscuring an already committed transition;
- integrations providing subtly different transaction guarantees.

Interlock standardizes this operation without owning the application's full persistence model.

---

## 5. Goals

### 5.1 Functional goals

The initial public alpha should support:

1. finite resource states;
2. named domain events;
3. static target state per event;
4. event-specific request input typing;
5. runtime input parsing and transformation;
6. application-provided authorization;
7. synchronous or asynchronous guards;
8. structured denials;
9. advisory assessment;
10. authoritative assessment inside a transaction;
11. deterministic transition planning;
12. decimal counter versions represented as opaque strings;
13. conditional state-and-version updates;
14. explicit related writes;
15. immutable transition history;
16. same-transaction concurrent idempotency;
17. transactional-outbox insertion;
18. one PostgreSQL transaction driver;
19. explicit resource bindings;
20. driver, binding, and executor test suites.

### 5.2 OSS-quality goals

The project should provide:

- strict TypeScript types and type-level regression tests;
- minimal runtime dependencies and no required ORM;
- ESM-first packaging with an explicit `exports` map;
- generated `.d.ts` files, source maps, and declaration maps;
- documented supported Node.js, TypeScript, PostgreSQL, and ORM versions;
- semantic versioning and a conventional changelog;
- reproducible builds and npm provenance;
- protected release workflows and mandatory maintainer 2FA;
- stable result variants, denial codes, and operational error codes;
- integration tests against real PostgreSQL connections;
- concurrency, fault-injection, and rollback tests;
- a public driver conformance suite and binding verification harness;
- a security policy and private vulnerability-reporting process;
- contribution guidelines, a code of conduct, governance expectations, and architecture decision records;
- realistic examples that run in CI;
- no telemetry, post-install network calls, hidden code generation, or hosted dependency;
- an explicit support and deprecation policy before `1.0`.

The repository should optimize for inspectability. Public guarantees must be traceable to executable tests, and package documentation must distinguish protocol guarantees from application responsibilities.

---

## 6. Non-goals

Interlock will not provide durable workflow execution, task queues, schedulers, automatic side-effect retries, distributed sagas, distributed transactions, compensation workflows, generic statecharts, hierarchical or parallel states, actors, frontend state management, an ORM, database migrations, an authorization policy language, event sourcing, CQRS infrastructure, generated APIs, a hosted dashboard, exactly-once external message delivery, direct-write prevention, or automatic stabilization of every row read by guards.

These exclusions are part of the product design.

---

## 7. Core terminology

### Resource

The application-owned persisted record whose lifecycle changes.

### Primary resource

The record whose state and version define the transition's primary concurrency boundary.

### Event

A named domain command such as `submit`, `approve`, `reject`, or `withdraw`.

### Normalized request

A request whose event is resolved, input has been parsed and transformed, expected-version input has been normalized, and an optional idempotency fingerprint has been calculated before opening the transaction.

### Assessment

A non-writing determination of whether the normalized event is allowed for a loaded resource.

### Transition plan

The deterministic write description produced after authoritative assessment, using a preallocated transition ID and one transition-scoped clock.

### Transition

A successfully committed application of an event.

### Guard

A domain predicate that must pass before the transition can commit.

### Transaction driver

The database-specific implementation responsible for opening the top-level transaction and persisting Interlock-owned idempotency, history, and outbox rows through the same transaction handle used by the application binding.

### Resource binding

Application-specific persistence behavior for loading and conditionally updating the primary resource, performing optional related writes, constructing lifecycle context, and declaring related-data consistency requirements.

### Lifecycle context

The typed read interface supplied to authorization and guard functions. It is constructed from a transaction handle for both advisory and authoritative assessment, with the execution mode made explicit.

### Rollback outcome

An internal control-flow signal used when an idempotency claim was inserted but the transition produces an expected non-committed result such as denial, not-found, or conflict. It causes the transaction to roll back while the public API still returns a result value.

---

## 8. Core design principles

### 8.1 Events represent intent

Interlock exposes domain commands rather than a generic `setState("approved")` operation.

### 8.2 The resource row remains authoritative

Transition history is not replayed to reconstruct state.

### 8.3 Input normalization precedes the transaction

Event lookup, expected-version validation, and pure input parsing occur before a database transaction is opened. This allows Interlock to calculate an idempotency fingerprint from normalized request data before claiming the key.

Schema parsing must be repeatable and must not depend on database reads, network calls, global randomness, or the current clock.

### 8.4 The executor owns the top-level transaction

`transition()` opens and controls the transaction that determines whether the result is committed. Ambient application transactions are not accepted in the initial release.

### 8.5 Assessment and planning are separate

Assessment answers whether an event is allowed. Planning creates the application mutation, audit projection, and outbox descriptors exactly once during authoritative execution.

### 8.6 Planning is pure given injected inputs

Mutation, audit, and outbox projections receive a preallocated transition ID and one clock. They must not call `crypto.randomUUID()`, `Date.now()`, or other global nondeterministic sources. Outbox message IDs are allocated by the executor only after descriptor count is known.

### 8.7 Primary-row consistency is not aggregate consistency

Optimistic concurrency protects the primary row. The binding must document, per event where necessary, how related facts used by guards are stabilized.

### 8.8 Business side effects use an outbox

Email, webhooks, broker publication, and remote API calls do not run in assessment or inside the database transaction.

### 8.9 Expected outcomes are values

Invalid input, unknown events, denials, conflicts, not-found results, duplicate success, and idempotency collisions return discriminated values. Unexpected infrastructure failures throw.

### 8.10 A claimed request either commits or leaves no claim

When a newly inserted idempotency claim is followed by an expected non-committed outcome, the executor rolls back the transaction before returning that result. Denied, not-found, invalid-state, and primary-version-conflict attempts do not leave incomplete claim rows.

### 8.11 Duplicate resolution reports history, not current authority

A duplicate retry reports a previously committed transition. It does not rerun current authorization or guards and does not automatically return the current resource. Any current-resource hydration is a separate, application-authorized operation.

---

## 9. JSON-safe public data

Audit data, transition metadata, denial details, and outbox payloads must use JSON-safe types.

```ts
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

`bigint`, `Date`, functions, symbols, class instances, and cyclic structures are not valid public payloads. Applications must normalize them explicitly.

---

## 10. Definition API

```ts
import {
  allow,
  defineLifecycle,
  deny,
} from "@jajego/interlock";
import { z } from "zod";

const applicationLifecycle = defineLifecycle({
  name: "application",
  definitionVersion: "1",

  history: {
    resourceType: "application",
    actor: (actor) => ({
      actorType: "user",
      actorId: actor.id,
    }),
    metadata: ({ request }) => ({
      source: request.metadata?.source ?? "unknown",
    }),
  },

  idempotency: {
    fingerprint: ({
      resourceId,
      event,
      parsedInput,
      actor,
      expectedVersion,
    }) =>
      canonicalHash({
        resourceId,
        event,
        input: parsedInput,
        actorId: actor.id,
        expectedVersion,
      }),
  },

  states: [
    "draft",
    "submitted",
    "under_review",
    "approved",
    "rejected",
    "withdrawn",
  ] as const,

  events: {
    submit: {
      from: ["draft"],
      to: "submitted",

      input: z.object({
        attestation: z.literal(true),
      }),

      authorize: ({ actor, resource }) =>
        actor.id === resource.ownerId
          ? allow()
          : deny({
              code: "NOT_RESOURCE_OWNER",
              publicMessage: "Only the application owner may submit it.",
            }),

      guards: [
        {
          name: "application-complete",
          evaluate: ({ resource }) =>
            resource.completionPercentage === 100
              ? allow()
              : deny({
                  code: "APPLICATION_INCOMPLETE",
                  publicMessage: "Complete all required fields before submitting.",
                }),
        },
      ],

      mutate: ({ actor, clock }) => ({
        submittedAt: clock.occurredAt,
        submittedById: actor.id,
      }),

      audit: () => ({
        attested: true,
      }),
    },

    approve: {
      from: ["under_review"],
      to: "approved",

      input: z.object({
        note: z.string().max(2_000).optional(),
      }),

      authorize: ({ actor }) =>
        actor.permissions.includes("applications:approve")
          ? allow()
          : deny({ code: "MISSING_PERMISSION" }),

      guards: [
        {
          name: "documents-verified",
          evaluate: async ({ resource, context }) =>
            (await context.documents.allVerified(resource.id))
              ? allow()
              : deny({
                  code: "DOCUMENTS_NOT_VERIFIED",
                  publicMessage: "All required documents must be verified.",
                }),
        },
      ],

      mutate: ({ actor, input, clock }) => ({
        approvedAt: clock.occurredAt,
        approvedById: actor.id,
        decisionNote: input.note ?? null,
      }),

      audit: ({ input }) => ({
        noteProvided: input.note !== undefined,
      }),

      outbox: ({ resource, transitionId }) => [
        {
          topic: "application.approved",
          key: resource.id,
          payload: {
            applicationId: resource.id,
            transitionId,
          },
        },
      ],
    },

    reject: {
      from: ["under_review"],
      to: "rejected",

      input: z.object({
        reason: z.enum([
          "INELIGIBLE",
          "INCOMPLETE_DOCUMENTATION",
          "DUPLICATE",
          "OTHER",
        ]),
        explanation: z.string().min(1).max(2_000),
      }),

      authorize: ({ actor }) =>
        actor.permissions.includes("applications:reject")
          ? allow()
          : deny({ code: "MISSING_PERMISSION" }),

      mutate: ({ actor, input, clock }) => ({
        rejectedAt: clock.occurredAt,
        rejectedById: actor.id,
        rejectionReason: input.reason,
        rejectionExplanation: input.explanation,
      }),

      audit: ({ input }) => ({
        reason: input.reason,
      }),
    },
  },
});
```

### 10.1 Construction-time validation

`defineLifecycle()` validates the definition once, not on every transition. It rejects duplicate states, unknown source or target states, accidental self-transitions, duplicate guard names, malformed event definitions, invalid lifecycle names, and unsupported schema adapters.

Binding creation performs additional validation that depends on the resource and driver contracts.

### 10.2 Static destinations only in alpha

Each event has one static target. Separate `approve` and `reject` events are preferred over a dynamic `completeReview` target because they produce clearer authorization, types, history, documentation, metrics, and fingerprints.

### 10.3 Schema interoperability

Interlock should support Standard Schema V1 directly or use a clearly named Interlock parser adapter. The system must distinguish caller input from parsed output because schemas may apply defaults or transformations.

---

## 11. Request normalization

Before opening the transaction, the executor performs pure request normalization through Interlock's normalized schema interface:

```ts
const event = lifecycle.getEvent(request.event);

if (!event) {
  return {
    status: "unknown-event",
    event: request.event,
  };
}

const parsedVersion = request.expectedVersion === "use-loaded-version"
  ? {
      success: true as const,
      value: request.expectedVersion,
    }
  : parseVersionToken(request.expectedVersion);

if (!parsedVersion.success) {
  return {
    status: "invalid-input",
    issues: [parsedVersion.issue],
  };
}

const parsed = await event.parseInput(request.input);

if (!parsed.success) {
  return {
    status: "invalid-input",
    issues: parsed.issues,
  };
}

const expectedVersion = parsedVersion.value;

const normalizedRequest = {
  resourceId: request.id,
  event: request.event,
  parsedInput: parsed.value,
  actor: request.actor,
  expectedVersion,
};

const fingerprint = request.idempotency
  ? lifecycle.idempotency.fingerprint(normalizedRequest)
  : undefined;
```

`event.parseInput()` is Interlock's normalized internal operation. It may be backed by Standard Schema V1, Zod, Valibot, or a Interlock-specific parser adapter, but the executor must not depend on a third-party library's throwing or result conventions.

Input parsing is not authoritative domain evaluation. It must be pure, repeatable, and safe to run before a transaction.

---

## 12. Public transition outcomes

```ts
export type TransitionResult<Resource, Transition> =
  | {
      status: "committed";
      duplicate: false;
      resource: Resource;
      transition: Transition;
    }
  | {
      status: "committed";
      duplicate: true;
      transition: Transition;
    }
  | {
      status: "denied";
      event: string;
      currentState: string;
      targetState?: string;
      reasons: readonly Denial[];
    }
  | {
      status: "conflict";
      expected: VersionExpectation;
      actual?: VersionSnapshot;
    }
  | {
      status: "not-found";
    }
  | {
      status: "unknown-event";
      event: string;
    }
  | {
      status: "invalid-input";
      issues: readonly InputIssue[];
    }
  | {
      status: "idempotency-conflict";
      key: string;
    };
```

A duplicate success replays the committed transition identity and outcome. It does not promise a byte-for-byte replay of the original response, rerun current lifecycle policy, or return the current resource. The resource may have advanced, become inaccessible, or been deleted after the original transition.

Unexpected database, serialization, driver, binding, cancellation, deadlock, lock-timeout, serialization-conflict, or ambiguous-commit failures throw typed `InterlockError` instances.

---

## 13. Assessment API

Advisory assessment should use the same typed lifecycle context surface as authoritative execution.

```ts
const assessment = await applications.assess({
  id: applicationId,
  event: "approve",
  input: { note: "Ready" },
  actor: currentActor,
});
```

### 13.1 Assessment transaction behavior

`assess()` opens a short transaction through the driver:

1. normalize event, input, and expected-version data before opening the transaction;
2. resolve the binding's advisory transaction options for the event;
3. open a transaction, normally read-only;
4. load the resource;
5. construct lifecycle context with `mode: "advisory"`;
6. evaluate state eligibility, authorization, and guards;
7. complete the transaction without writes.

This keeps advisory and authoritative guard interfaces aligned while allowing their query behavior to differ. Advisory context must not acquire authoritative locks merely to preview an action. Assessment remains advisory: no reservation guarantees that a later transition will still succeed.

### 13.2 Assessment does not plan

Assessment does not allocate IDs, create timestamps, generate mutations, project audit data, or create outbox descriptors.

### 13.3 `availableTransitions()` is deferred

Events requiring input cannot always be fully assessed without per-event input. A generic all-events API is deferred from the initial release.

---

## 14. Lifecycle context factory

```ts
export type AssessmentMode = "advisory" | "authoritative";

export interface LifecycleContextFactory<Transaction, Context> {
  create(
    transaction: Transaction,
    options: {
      mode: AssessmentMode;
      event: string;
    },
  ): Context;
}
```

The binding supplies a factory that converts the raw database transaction handle into the typed read context used by lifecycle callbacks.

```ts
const contextFactory: LifecycleContextFactory<
  DbTransaction,
  AppLifecycleContext
> = {
  create: (tx, { mode }) => ({
    documents: {
      allVerified: async (applicationId) => {
        if (mode === "authoritative") {
          await tx.$queryRaw`
            SELECT id
            FROM application_documents
            WHERE application_id = ${applicationId}
            FOR UPDATE
          `;
        }

        const count = await tx.document.count({
          where: {
            applicationId,
            verified: false,
          },
        });

        return count === 0;
      },
    },
  }),
};
```

The example illustrates a mode-aware implementation; a binding may instead use aggregate versioning, serializable isolation, constraints, or another documented strategy. The context must not outlive the transaction callback.

---

## 15. Assessment semantics

Default order:

1. source-state eligibility;
2. authorization;
3. guards.

Authorization runs before guards to reduce information leakage. The alpha uses fail-fast behavior rather than collecting all denial reasons.

Guards may read through lifecycle context and may be asynchronous. They must not perform irreversible side effects or mutate database state. They must tolerate repeated execution.

---

## 16. Planning

After authoritative assessment succeeds inside the transaction, the executor allocates the transition ID and transition-scoped clock:

```ts
interface TransitionIdentity {
  transitionId: string;
}

interface TransitionClock {
  occurredAt: Date;
}
```

The executor invokes pure projection functions to create:

- the application-defined mutation;
- JSON-safe audit data;
- outbox descriptors.

```ts
interface OutboxDescriptor {
  topic: string;
  key?: string;
  payload: JsonValue;
}
```

The plan is finalized in two phases:

1. allocate the transition ID and clock;
2. generate mutation, audit, and outbox descriptors;
3. allocate one outbox message ID for each returned descriptor;
4. combine descriptors with IDs, timestamps, lifecycle metadata, and transition metadata;
5. validate JSON serialization and payload limits.

Lifecycle projections never allocate outbox IDs or timestamps themselves. Planning must not make network calls, load additional state, call global randomness, call the current clock, or persist anything.

---

## 17. Version model

The alpha deliberately supports positive decimal monotonic counters rather than arbitrary version strategies.

```ts
export type VersionToken = string & {
  readonly __brand: "VersionToken";
};

export type VersionTokenParseResult =
  | {
      success: true;
      value: VersionToken;
    }
  | {
      success: false;
      issue: InputIssue;
    };

export function parseVersionToken(
  value: unknown,
): VersionTokenParseResult {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value)
  ) {
    return {
      success: false,
      issue: {
        path: ["expectedVersion"],
        code: "INVALID_VERSION_TOKEN",
        message: "Expected a positive decimal version string.",
      },
    };
  }

  return {
    success: true,
    value: value as VersionToken,
  };
}

export function incrementVersion(version: VersionToken): VersionToken {
  return String(BigInt(version) + 1n) as VersionToken;
}
```

Recommended PostgreSQL storage:

```sql
version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1)
```

The public representation is a string because JavaScript numbers cannot safely represent every PostgreSQL `BIGINT` value and strings pass safely through JSON, HTTP, browsers, drivers, and ORMs.

Interlock is ORM-neutral in the alpha, but intentionally not version-strategy-neutral.

---

## 18. Architecture

Interlock consists of four primary pieces.

### 18.1 Lifecycle definition

Owns states, events, normalized input schemas, authorization, guards, mutation projection, audit projection, outbox projection, history identity projection, and idempotency fingerprinting.

### 18.2 Lifecycle executor

Owns request normalization, transaction scope, idempotency resolution, authoritative assessment, rollback of expected non-committed outcomes after a claim, ID and clock allocation, planning, operation ordering, and result normalization.

### 18.3 Transaction driver

Owns PostgreSQL transaction creation, isolation configuration, Interlock-owned idempotency records, transition-history persistence, outbox persistence, and database error normalization.

The transaction driver must execute Interlock-owned writes through the same transaction handle used by the resource binding. A raw `pg` implementation is the reference path. A Prisma integration must use a Prisma interactive-transaction handle, including raw Interlock-table queries through that same handle; it must not combine an independent raw `pg` transaction with a Prisma transaction.

### 18.4 Resource binding

Owns application-specific resource loading, state and version extraction, conditional primary update, optional related writes, mode-aware context construction, optional in-transaction hydration, transaction requirements, and event-specific related-data consistency documentation.

### 18.5 ORM-neutral does not mean transaction-host-neutral

Interlock's domain definition is ORM-neutral. Its transaction driver must still be compatible with the application's transaction host.

The first implementation should prove two hosts:

1. `pg`, used end to end by the reference driver and binding;
2. a Prisma PostgreSQL spike in which Interlock-owned SQL and application model writes share one interactive transaction handle.

A broad ORM package should not be published until shared-handle behavior is demonstrated by integration tests.

---

## 19. Transaction-driver protocol

```ts
export interface TransactionOptions {
  isolation?: "read-committed" | "repeatable-read" | "serializable";
  readOnly?: boolean;
}

export interface TransactionDriver<Transaction> {
  transaction<Result>(
    operation: (transaction: Transaction) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;

  claimIdempotency(
    transaction: Transaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult>;

  completeIdempotency(
    transaction: Transaction,
    completion: {
      lifecycle: string;
      resourceId: string;
      key: string;
      transitionId: string;
      completedAt: Date;
    },
  ): Promise<void>;

  insertTransition(
    transaction: Transaction,
    transition: TransitionInsert,
  ): Promise<TransitionRecord>;

  insertOutbox(
    transaction: Transaction,
    messages: readonly OutboxInsert[],
  ): Promise<void>;
}
```

The executor may throw an internal rollback sentinel from inside `transaction()` to return an expected non-committed public result while ensuring that a newly inserted idempotency claim and any accidental writes are rolled back. Drivers must roll back on every thrown value and preserve the original cause when normalizing failures.

The alpha should not expose unused generic capabilities such as savepoints or a broad `rowLocking` flag. Locking required by a binding is expressed through the binding's transaction options and queries.

---

## 20. Resource-binding protocol

```ts
export interface ResourceBinding<
  Transaction,
  Resource,
  Mutation,
  Context,
> {
  transactionOptions(args: {
    mode: AssessmentMode;
    event: string;
  }): TransactionOptions;

  loadPrimary(
    transaction: Transaction,
    id: string,
  ): Promise<Resource | null>;

  getId(resource: Resource): string;
  getState(resource: Resource): string;
  getVersion(resource: Resource): VersionToken;

  applyPrimary(
    transaction: Transaction,
    args: {
      resource: Resource;
      fromState: string;
      toState: string;
      expectedVersion: VersionToken;
      nextVersion: VersionToken;
      mutation: Mutation;
    },
  ): Promise<
    | {
        status: "applied";
        resource: Resource;
      }
    | {
        status: "conflict";
        actual?: VersionSnapshot;
      }
    | {
        status: "not-found";
      }
  >;

  applyRelated?(
    transaction: Transaction,
    args: {
      previousResource: Resource;
      updatedResource: Resource;
      mutation: Mutation;
      transitionId: string;
      occurredAt: Date;
    },
  ): Promise<void>;

  hydrateBeforeCommit?(
    transaction: Transaction,
    resource: Resource,
  ): Promise<Resource>;

  contextFactory: LifecycleContextFactory<Transaction, Context>;

  consistency(event: string): RelatedDataConsistency;
}
```

`applyPrimary()` should use `UPDATE ... RETURNING` where practical and return the updated resource. If additional joins or computed data are required, `hydrateBeforeCommit()` may run inside the same transaction. A required post-commit reload is not part of the alpha.

`applyRelated()` receives the same application-defined mutation consumed by `applyPrimary()`. It is separate so ordering, transaction-handle propagation, and fault injection remain explicit.

`transactionOptions()` allows an event to request, for example, `SERIALIZABLE` authoritative execution while using a short read-only `READ COMMITTED` advisory assessment. The driver must reject unsupported requirements rather than silently weaken them.

---

## 21. Executor protocol

The alpha executor sequence is:

```text
1. Resolve the event from the untyped boundary.
2. Parse and normalize expected version and request input.
3. Calculate the idempotency fingerprint from normalized request data.
4. Resolve authoritative transaction options for the event.
5. Begin the top-level database transaction.
6. Atomically claim or resolve the idempotency key.
7. If duplicate committed, return the stored transition without rerunning current policy.
8. Load the authoritative primary resource.
9. If absent after a newly inserted claim, roll back and return not-found.
10. Compare the caller's expected version when supplied.
11. If stale after a newly inserted claim, roll back and return conflict.
12. Build lifecycle context with mode authoritative.
13. Perform authoritative state, authorization, and guard assessment.
14. If denied after a newly inserted claim, roll back and return denied.
15. Allocate transition ID and one transition-scoped clock.
16. Generate mutation, audit data, and outbox descriptors.
17. Allocate outbox IDs and finalize the transition plan.
18. Validate JSON serialization and payload limits.
19. Conditionally apply the primary-resource update.
20. If the update conflicts, roll back and return conflict.
21. Apply declared related writes using the same mutation.
22. Insert immutable transition history.
23. Insert finalized outbox messages.
24. Complete the idempotency record with transition identity.
25. Optionally hydrate the resource inside the transaction.
26. Commit.
27. Return committed success.
```

Expected non-committed outcomes produced after a new claim use an internal rollback sentinel. The sentinel is translated back into the appropriate public result only after the driver confirms rollback.

The exact same transaction handle must be passed to all transaction-scoped operations. It must not be retained after callback completion.

---

## 22. Ambient transaction policy

The alpha does not support:

```ts
await db.transaction(async (tx) => {
  await doOtherWork(tx);
  await applications.transitionWithin(tx, request);
});
```

Interlock cannot truthfully return `status: "committed"` while an outer caller still controls the final commit.

A future API may support staging:

```ts
const staged = await applications.stage(tx, request);
```

Such an API must return `status: "staged"`, not `committed`, and is outside the initial scope.

---

## 23. Primary-resource concurrency

The conditional update checks both state and version:

```sql
UPDATE applications
SET
  status = 'approved',
  version = version + 1,
  approved_at = $1,
  approved_by_id = $2
WHERE
  id = $3
  AND status = 'under_review'
  AND version = 7
RETURNING *;
```

Exactly one returned row means success. No row means the resource was deleted, state changed, version changed, or an out-of-band update occurred.

External commands should supply an `expectedVersion`. A distinct internal mode may explicitly use the loaded version, but that must never be the implicit default.

---

## 24. Related-data consistency

Optimistic concurrency protects the primary resource only.

If a guard checks related rows, another transaction may change those rows before commit unless the binding provides additional protection.

Bindings declare an event-specific related-data strategy:

```ts
export type RelatedDataConsistency =
  | { strategy: "none"; notes: string }
  | { strategy: "row-locking"; notes: string }
  | { strategy: "aggregate-version"; notes: string }
  | { strategy: "dependency-version"; notes: string }
  | { strategy: "serializable"; notes: string }
  | { strategy: "database-constraint"; notes: string }
  | { strategy: "custom"; notes: string };

const consistencyByEvent = {
  submit: {
    strategy: "none",
    notes: "Submission depends only on the primary application row.",
  },
  approve: {
    strategy: "row-locking",
    notes: "Relevant document rows are locked during authoritative approval.",
  },
} satisfies Record<string, RelatedDataConsistency>;
```

Possible techniques include `SELECT ... FOR UPDATE`, incrementing the primary version when relevant child rows change, checking dependency versions, serializable isolation, database constraints, or versioned materialized eligibility fields.

Advisory and authoritative context may use the same method surface but different query behavior. Advisory assessment should not acquire locks merely to preview eligibility; authoritative execution must apply the strategy declared for that event.

Interlock must never claim that guards remain true until commit merely because they ran inside a transaction.

---

## 25. Idempotency protocol

### 25.1 Same-transaction model

The alpha uses one atomic transaction for the idempotency claim and transition. It does not persist externally visible `in_progress` or `failed` claims and does not implement leases, expiration, stale-owner recovery, or polling.

Within the transition transaction:

1. insert an idempotency row with a unique key;
2. perform the transition;
3. update the row with `transition_id` and `completed_at`;
4. commit everything together.

Concurrent inserts on the same unique key are coordinated by PostgreSQL. A competing transaction waits for the first transaction's uniqueness outcome:

- if the owner commits, the competitor observes the committed claim;
- if the owner rolls back, the competitor can insert its own claim;
- no durable `in_progress` recovery state is required.

### 25.2 Non-committed attempts

When the current transaction inserted a new claim but later produces `not-found`, `denied`, or `conflict`, the executor must roll back before returning the result. Such attempts leave no idempotency row.

Unknown events and invalid input are resolved before a transaction opens and therefore never create a claim.

A conformance test must prove that a denied transition after claim insertion leaves no durable claim and can be retried later with the same key.

### 25.3 Required concurrent behavior

| Concurrent requests | Required result |
|---|---|
| Same key, same fingerprint | Exactly one mutation; both identify the same committed transition |
| Same key, different fingerprint | One may commit; the other returns `idempotency-conflict` |
| Different keys, same expected version | Exactly one commits; the other returns `conflict` |

### 25.4 Fingerprinting

Interlock must not infer semantic request identity from arbitrary JSON serialization. The lifecycle or binding supplies canonical fingerprinting based on normalized request data.

```ts
idempotency: {
  fingerprint: ({
    resourceId,
    event,
    parsedInput,
    actor,
    expectedVersion,
  }) => canonicalHash({
    resourceId,
    event,
    input: parsedInput,
    actorId: actor.id,
    expectedVersion,
  }),
}
```

The canonicalizer must define handling for dates, object key order, defaults, transformed values, omitted fields, actor identity, resource identity, and expected-version mode.

### 25.5 Storage

The alpha PostgreSQL package mandates Interlock-owned idempotency, history, and outbox tables. That opinionated schema is acceptable initially and must be documented as part of the PostgreSQL package's compatibility contract.

```sql
CREATE TABLE interlock_idempotency (
  lifecycle TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  transition_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (lifecycle, resource_id, idempotency_key),
  CHECK (
    (transition_id IS NULL AND completed_at IS NULL)
    OR
    (transition_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);
```

No incomplete row may survive a committed transaction. A committed duplicate returns the original transition, not an original resource snapshot.

### 25.6 Duplicate authorization semantics

Duplicate resolution intentionally precedes current resource loading, authorization, and guard evaluation. It reports a historical outcome rather than requesting a new transition.

The duplicate result must expose only the transition and replay-safe fields stored in Interlock-owned history. Applications that need the current resource must load it separately through their normal authorization boundary.

---

## 26. Transition history

```ts
export interface TransitionRecord {
  id: string;
  lifecycle: string;
  resourceType: string;
  resourceId: string;
  event: string;
  fromState: string;
  toState: string;
  previousVersion: VersionToken;
  nextVersion: VersionToken;
  actorType?: string;
  actorId?: string;
  auditData?: JsonValue;
  metadata?: JsonValue;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  definitionVersion?: string;
  occurredAt: Date;
}
```

History identity and metadata are explicitly projected rather than inferred from arbitrary actor or request objects:

```ts
history: {
  resourceType: "application",
  actor: (actor) => ({
    actorType: "user",
    actorId: actor.id,
  }),
  metadata: ({ request }) => ({
    source: request.metadata?.source ?? "unknown",
  }),
}
```

History projections must return JSON-safe values and must not expose private actor or request fields by default.

History is append-only and is not an event store. Raw request input is excluded by default. Lifecycle definitions explicitly project audit-safe JSON.

---

## 27. Transactional outbox

Outbox projections return descriptors only:

```ts
outbox: ({ resource, transitionId }) => [
  {
    topic: "application.approved",
    key: resource.id,
    payload: {
      applicationId: resource.id,
      transitionId,
    },
  },
]
```

The executor first evaluates the projection, then allocates one message ID per descriptor, and finally attaches timestamps, lifecycle metadata, and transition metadata. It validates JSON serialization and payload limits before the primary update is allowed to commit.

The resource update, related writes, history row, idempotency completion, and outbox rows commit atomically. Interlock does not guarantee broker delivery, consumer idempotency, ordering, dead-letter behavior, or exactly-once consumption.

Arbitrary business-critical `afterCommit` callbacks are excluded from the alpha.

---

## 28. Denial model

```ts
export interface Denial {
  source: "state" | "authorization" | "guard";
  rule?: string;
  code: string;
  publicMessage?: string;
  privateMessage?: string;
  details?: JsonValue;
}
```

Authorization runs before guards by default. Public callers receive only public-safe fields.

---

## 29. Error model

Expected outcomes are result variants. Unexpected failures extend:

```ts
export abstract class InterlockError extends Error {
  abstract readonly code: string;
  readonly cause?: unknown;
}
```

Initial codes:

```text
INTERLOCK_DEFINITION_INVALID
INTERLOCK_DRIVER_UNSUPPORTED
INTERLOCK_DRIVER_PROTOCOL_VIOLATION
INTERLOCK_BINDING_PROTOCOL_VIOLATION
INTERLOCK_TRANSACTION_FAILED
INTERLOCK_PERSISTENCE_FAILED
INTERLOCK_SERIALIZATION_FAILED
INTERLOCK_SERIALIZATION_CONFLICT
INTERLOCK_DEADLOCK
INTERLOCK_LOCK_TIMEOUT
INTERLOCK_COMMIT_OUTCOME_UNKNOWN
INTERLOCK_OUTBOX_FAILED
INTERLOCK_HISTORY_FAILED
INTERLOCK_CANCELLED
```

A primary-resource compare-and-swap miss is the expected `status: "conflict"` result. PostgreSQL serialization failures, deadlocks, lock timeouts, and ambiguous connection loss during commit are operational errors and must not be normalized into a domain conflict.

`INTERLOCK_COMMIT_OUTCOME_UNKNOWN` is reserved for cases where the client cannot determine whether the database committed. Callers should retry only with the same idempotency key and fingerprint.

---

## 30. Reload and hydration semantics

`applyPrimary()` should return the updated resource using `UPDATE ... RETURNING` where possible.

If the application needs additional joins or computed data, `hydrateBeforeCommit()` may run inside the transaction. If it fails, the transaction rolls back.

The alpha does not require a post-commit reload. A later optional hydration API may separately report that the transition committed even if post-commit hydration failed.

---

## 31. Test architecture

Testing responsibilities are split into three layers.

### 31.1 Driver conformance

Verifies transaction commit and rollback, requested isolation, read-only behavior, idempotency unique-conflict behavior, history insertion, outbox insertion, transaction-handle lifetime, and database error normalization.

### 31.2 Binding verification

Verifies state-and-version predicates, affected-row behavior, `UPDATE ... RETURNING`, explicit related writes receiving the mutation, in-transaction hydration, mode-aware context construction, per-event transaction options, and the declared related-data strategy.

### 31.3 Executor integration suite

Verifies cross-component ordering and atomicity:

- history failure rolls back resource and related writes;
- outbox failure rolls back resource and history;
- idempotency completion failure rolls back everything;
- a denial after claim insertion rolls back and leaves no claim row;
- a not-found result after claim insertion rolls back and leaves no claim row;
- a version conflict after claim insertion rolls back and leaves no claim row;
- lost responses replay the committed transition;
- duplicate resolution does not rerun current policy;
- duplicate resolution does not expose a current resource automatically;
- the same transaction handle reaches Interlock-owned and application-owned operations;
- serialization fails before the primary update;
- ambient transaction use is rejected.

### 31.4 Required race tests

1. `approve` and `reject` against the same version: exactly one commits.
2. Same idempotency key and fingerprint: one mutation, same transition identity.
3. Same key and different fingerprints: deterministic collision.
4. Same key and different expected versions: deterministic idempotency collision.
5. Different keys and same expected version: one commit, one conflict.
6. Related-row mutation race: behavior matches the event's declared strategy.
7. Owner transaction rolls back after idempotency insert: competing request can proceed.

### 31.5 Required failure tests

- transition-history insertion fails;
- outbox insertion fails;
- idempotency completion fails;
- database commit fails;
- commit outcome becomes ambiguous after connection loss;
- in-transaction hydration fails;
- connection drops during execution;
- payload serialization fails;
- transaction context is used after callback completion;
- driver silently weakens requested isolation;
- Prisma and Interlock-owned SQL use different transaction handles.

Real PostgreSQL connections must be used; mocked transactions are insufficient for advertised durability guarantees.

---

## 32. Package architecture

Initial repository:

```text
packages/
  core/
  postgres/
  conformance/

examples/
  postgres-node/
  prisma-postgres-spike/
```

### `@jajego/interlock`

Lifecycle definitions, type inference, schema normalization, request normalization, assessment, planning, executor, result types, denial types, transaction-driver interfaces, resource-binding interfaces, and history/idempotency projection contracts.

### `@jajego/interlock-postgres`

Reference `pg` transaction driver, Interlock-owned schema, same-transaction idempotency, history persistence, outbox persistence, and PostgreSQL error normalization.

### `@jajego/interlock-conformance`

Driver conformance, binding verification, executor integration fixtures, concurrency helpers, and fault injection.

### Prisma PostgreSQL spike

The initial Prisma work is an executable compatibility spike, not a published integration package. It must demonstrate that application model writes and Interlock-owned SQL execute through one Prisma interactive-transaction handle.

A first-party Prisma package should not be published until this behavior is proven and the transaction-host contract is stable.

### Repository and release quality

The repository should include:

```text
.changeset/
.github/
  CODEOWNERS
  ISSUE_TEMPLATE/
  pull_request_template.md
  workflows/
    ci.yml
    release.yml
  dependabot.yml

docs/
  architecture/
  concepts/
  guides/
  adr/

CONTRIBUTING.md
CODE_OF_CONDUCT.md
GOVERNANCE.md
SECURITY.md
LICENSE
README.md
SUPPORT.md
```

CI should verify formatting, linting, unit tests, type tests, package exports, clean-room installation, example builds, generated declarations, PostgreSQL integration tests, concurrency tests, and provenance-capable release builds.

Published packages should contain only intentional files, expose stable subpaths through `exports`, avoid install scripts, declare runtime and peer dependencies precisely, and document their Node.js and TypeScript support windows.

Deferred packages include Drizzle, Kysely, documentation generation, OpenTelemetry, a testing DSL, and visual tooling.

---

## 33. First public alpha

The first public version must prove the transaction thesis. It should include:

- `defineLifecycle()`;
- construction-time definition validation;
- static targets;
- parsed event-specific input;
- authorization and guards;
- advisory `assess()` using a read-only transaction;
- authoritative `transition()`;
- discriminated expected outcomes;
- PostgreSQL transaction driver;
- Interlock-owned PostgreSQL tables;
- a raw `pg` reference transaction host;
- one explicit resource binding;
- decimal counter version tokens;
- conditional update with `RETURNING`;
- explicit related writes;
- immutable transition history;
- same-transaction idempotency with rollback of non-committed attempts;
- optional transactional outbox;
- driver, binding, and executor test layers;
- one realistic application example;
- one Prisma shared-transaction compatibility spike.

It should defer dynamic destinations, nested states, ambient transactions, pessimistic-locking DSLs, collect-all assessment, arbitrary `afterCommit`, multiple ORM packages, elaborate graph tooling, and a hosted service.

A definitions-only release should not be published because it would present Interlock as another small state-machine library.

---

## 34. Security considerations

Interlock cannot prevent direct state writes outside the binding. Mitigations include repository encapsulation, database roles, architecture tests, code review rules, and optional triggers.

Authorization precedes guards to limit information leakage. Duplicate idempotency resolution returns only stored transition data and does not automatically expose the current resource. Raw request input is not stored automatically. Audit and outbox payloads are JSON-safe and explicitly projected. Generic deep merging should be avoided. Outbox payload sizes should be configurable. Releases should use protected workflows, npm provenance, mandatory maintainer 2FA, dependency review, and minimal runtime dependencies.

---

## 35. Observability

Interlock may expose observational instrumentation callbacks for assessment completion, transition commitment, denial, conflict, duplicate resolution, and operational failure.

Instrumentation must not include raw input or complete resources by default and must not be used for reliable domain side effects.

---

## 36. Performance considerations

A transition may require an idempotency insert or conflict wait, primary load, guard reads, conditional update, related writes, history insert, outbox insert, idempotency completion, and optional in-transaction hydration.

Interlock is intended for business-significant transitions rather than high-frequency telemetry.

Transactions should avoid external HTTP calls, remote authorization, file processing, broker publication, and long computation. Guards run sequentially in the alpha for predictable transaction use and fail-fast behavior.

Type definitions should avoid deeply recursive conditional types. Editor responsiveness and readable errors are more important than proving arbitrary graph properties at compile time.

---

## 37. Definition versioning

Transition history may record a `definitionVersion`. Interlock does not provide a lifecycle migration engine.

Renaming or removing states requires application data migration. Adding events is usually additive. Guard changes affect future eligibility. Input schema changes may be API-breaking. Definition versions aid interpretation but do not support event replay.

---

## 38. Scope-control rules

The project should generally decline requests to add delayed execution, retryable workflow steps, nested states, distributed compensation, event-store replay, a permission language, automatic ORM inference, ambient transaction support in the alpha, or exactly-once external delivery.

Use a workflow engine for durable process execution, XState for statecharts, an event-sourcing framework for replay, and an authorization system for policy definition.

---

## 39. Major risks

### Too little value over service methods

Mitigate with excellent result ergonomics, reliable idempotency, strong race behavior, explicit rollback guarantees, realistic examples, and low ceremony.

### Becoming a state-machine DSL

Ship PostgreSQL execution in the first release and market the commit protocol rather than the graph.

### Misleading consistency claims

Explicitly separate primary-resource concurrency from related-data consistency and test declared strategies.

### Binding complexity

Use explicit interfaces, realistic examples, and kill the public package if bindings remain harder to understand than handwritten services.

### Idempotency complexity

Use the same-transaction PostgreSQL model and avoid leases, polling, recovery workers, or durable-operation semantics.

### Adapter inconsistency

Start with one PostgreSQL driver, one schema, and one conformance suite.

---

## 40. Kill criteria

Interlock should not become a public package if:

1. the executor is more complex than the service code it replaces;
2. bindings require excessive boilerplate;
3. same-transaction idempotency remains difficult to explain or implement;
4. related-data guarantees are routinely misunderstood;
5. the primary value reduces to declaring states and guards;
6. users consistently need a workflow engine rather than an atomic transition;
7. the three-layer test model cannot verify advertised guarantees;
8. the PostgreSQL implementation requires broad persistence ownership inconsistent with the product thesis;
9. Interlock-owned and application-owned writes cannot share one transaction handle across realistic integrations.

---

## 41. Success criteria

The prototype succeeds if:

1. a developer understands the atomic guarantee from the README;
2. lifecycle behavior is easier to inspect than scattered service code;
3. same-version races behave deterministically;
4. same-key retries resolve to one transition;
5. different fingerprints collide safely;
6. history or outbox failures roll back the resource;
7. related-data consistency is explicit rather than implied;
8. application schemas remain application-owned;
9. the package remains clearly distinct from XState, workflow systems, and full persistence frameworks;
10. a Prisma compatibility spike proves that Interlock-owned and application-owned writes can share one transaction handle.

---

## 42. Recommended README opening

> Interlock applies type-safe, atomic domain transitions to ordinary PostgreSQL records.
>
> It is designed for resources such as applications, permits, orders, reports, and accounts—where a state change must validate input, enforce domain rules, detect concurrent edits, leave immutable history, and reliably request downstream work.
>
> Interlock ensures that the version-checked resource update, related writes, transition-history record, idempotency result, and outbox messages commit together or do not happen.
>
> Interlock is not a workflow engine or generic statechart runtime. Each transition owns and completes one top-level application database transaction.

Avoid positioning such as “XState for databases,” “a lightweight Temporal,” “event sourcing made easy,” “exactly-once execution,” “ACID across any database,” or “replace your service layer.”

---

## 43. Implementation recommendation

Freeze the product design after this version and validate it through executable artifacts.

The next implementation milestone should contain:

1. executable TypeScript interfaces for lifecycle definitions, normalized schemas, driver, binding, context factory, executor, history projection, idempotency projection, and results;
2. Interlock-owned PostgreSQL schema;
3. a raw `pg` end-to-end transition test;
4. a denied-after-claim rollback test proving no claim row remains;
5. an approve/reject concurrency test;
6. a same-key idempotency race test;
7. a different-fingerprint collision test;
8. a same-key/different-version collision test;
9. a history rollback test;
10. an outbox rollback test;
11. a related-row consistency test using mode-aware context;
12. a lost-response retry test;
13. a Prisma shared-transaction compatibility spike;
14. a clean-room package installation and example build in CI.

The project is compelling only if it makes this operation safer, clearer, and easier to reuse:

```text
normalize request and expected version
→ calculate fingerprint
→ resolve event transaction requirements
→ begin top-level transaction
→ claim idempotency
→ return stored transition if duplicate committed
→ load authoritative resource
→ assess command with authoritative context
→ roll back expected non-committed outcomes
→ allocate transition ID and clock
→ create deterministic mutation, audit, and outbox descriptors
→ allocate outbox IDs and finalize plan
→ validate serialization and limits
→ conditionally update state and version
→ perform related writes
→ write immutable transition history
→ write outbox messages
→ complete idempotency
→ optionally hydrate before commit
→ commit all or roll back all
```

Its differentiator is not that developers can declare states, events, and guards.

Its differentiator is:

> **Interlock ensures that a domain command, its version-checked resource update, its related writes, its transition history, its idempotency outcome, and its outbox messages either commit together or do not happen.**

---
