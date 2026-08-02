# Interlock

[![CI](https://github.com/jajego/interlock/actions/workflows/ci.yml/badge.svg)](https://github.com/jajego/interlock/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@interlock/core?label=npm)](https://www.npmjs.com/package/@interlock/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Type-safe, atomic lifecycle transitions for PostgreSQL.**

Interlock gives important domain changes one dependable transaction boundary.
Your version-checked resource update, related writes, append-only history,
idempotency result, and outbox messages commit together or roll back together.

XState models complex statecharts. Temporal runs durable workflows. Interlock
makes a single domain transition, and every database write it requires, commit
atomically in PostgreSQL. Use it for approvals, account status changes, order
progression, publishing flows, fulfillment steps, and other business transitions
where a partial write would be expensive or difficult to repair.

## Why Interlock?

- **Atomic by design:** application writes, history, idempotency, and outbox
  records share one PostgreSQL transaction.
- **Type-safe commands:** lifecycle definitions infer valid event names and
  input types for `assess()` and `transition()`.
- **Safe concurrency:** compare-and-swap updates check both state and version.
- **Built-in audit trail:** the protocol appends a record for every committed
  transition.
- **Retry-friendly APIs:** idempotency keys return the original committed
  transition instead of applying it twice.
- **PostgreSQL-native:** bring your own `pg` pool and write ordinary SQL against
  ordinary application tables.
- **Round-trip conscious:** transactional-outbox rows are inserted in batches
  without skipping protocol validation.
- **Small footprint:** `@interlock/core` has zero external runtime dependencies.

| Tool                | Best fit                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| **Interlock**       | One version-checked domain transition and all of its PostgreSQL writes. |
| **XState**          | Rich in-process statecharts and state-machine modeling.                 |
| **Temporal**        | Durable, long-running workflows across processes and services.          |
| **ORM transaction** | General database work when you own the transaction protocol yourself.   |

## Install

```sh
npm install @interlock/core@next @interlock/postgres@next pg
```

Your application owns the `pg` `Pool`. The PostgreSQL package imports `pg` only
as a type and declares it as a peer dependency.

## Integration requirements

- PostgreSQL is the reference and only first-party transaction driver; packages
  are ESM-only and require Node.js 22.14+.
- Resource IDs are strings and versions are positive PostgreSQL `BIGINT` tokens
  represented as strings.
- Idempotent transitions require Read Committed. Interlock owns the top-level
  transaction; ambient transaction composition is not supported.
- Application tables, SQL or ORM code, tenancy, authorization, and related-row
  consistency remain application-owned. Direct writes can bypass Interlock.
- Duplicate replay returns stored transition history, not necessarily the
  current resource. Outbox delivery remains outside Interlock.
- Related-row correctness is declared by the binding. Self-transitions are
  rejected; model them as ordinary application writes instead.
- Prisma is proven through an executable shared-transaction spike, not a
  published adapter. Application and Interlock writes must use one transaction
  handle.

## Replace transaction scripts with one command

Without Interlock, each command handler must remember the same protocol:

```ts
await client.query("BEGIN");
await claimIdempotency(client, command);
await updateOrderIfVersionMatches(client, command);
await insertDecision(client, command);
await insertHistory(client, command);
await insertOutbox(client, command);
await completeIdempotency(client, command);
await client.query("COMMIT");
```

With Interlock, the lifecycle and binding define those pieces once:

```ts
const result = await orders.transition(command);
```

Interlock owns the transaction boundary; your binding still owns ordinary SQL.

## Quick start

### 1. Define a lifecycle

```ts
import { defineEvent, defineLifecycle, deny } from "@interlock/core";

interface Order {
  id: string;
  state: string;
  version: string;
}

interface Actor {
  id: string;
  canApprove: boolean;
}

const event = defineEvent<Order, Actor>();
const orderLifecycle = defineLifecycle<Order, Actor>()({
  name: "order",
  states: ["pending", "approved"],
  history: {
    resourceType: "order",
    actor: (actor) => ({ actorType: "user", actorId: actor.id }),
  },
  events: {
    approve: event({
      from: ["pending"],
      to: "approved",
      authorize: ({ actor }) =>
        actor.canApprove ? true : deny({ code: "NOT_ALLOWED" }),
      mutate: ({ actor }) => ({ approvedBy: actor.id }),
      outbox: ({ resource, transitionId }) => [
        {
          topic: "order.approved",
          key: resource.id,
          payload: { orderId: resource.id, transitionId },
        },
      ],
    }),
  },
});
```

### 2. Connect your table

A resource binding maps Interlock's transaction protocol to your existing
tables. `loadPrimary()` receives the immutable operation before policy runs, so
it can apply tenant-local transaction context without closure state:

```ts
loadPrimary: async (transaction, operation) => {
  await transaction.query("select set_config('app.tenant_id', $1, true)", [
    operation.actor.tenantId,
  ]);
  return loadOrder(transaction, operation.id);
};
```

`applyPrimary()` receives the selected event and its correlated mutation on
`args.operation`; the compare-and-swap remains ordinary SQL:

```sql
UPDATE orders
SET state = $2, version = $3, approved_by = $4
WHERE id = $1 AND state = $5 AND version = $6
RETURNING *;
```

Create the client with your binding and pool:

```ts
import { createInterlock } from "@interlock/core";
import { PostgresDriver } from "@interlock/postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const orders = createInterlock({
  lifecycle: orderLifecycle,
  binding: orderBinding,
  driver: new PostgresDriver(pool),
});
```

See the [`postgres-node` example](examples/postgres-node/README.md) for the
complete binding, migration setup, related writes, guards, history, and outbox
code.

### 3. Assess and transition

Use `assess()` for advisory feedback in a UI. It performs a read-only check and
does not reserve or guarantee the transition. Calling `assess()` immediately
before `transition()` intentionally repeats authoritative reads and checks, so
servers should not make that a mechanical part of every command.

```ts
const assessment = await orders.assess({
  id: "order-123",
  event: "approve",
  actor: reviewer,
});
```

Use `transition()` for the authoritative command. Interlock rechecks policy and
commits everything in one transaction.

```ts
const result = await orders.transition({
  id: "order-123",
  event: "approve",
  actor: reviewer,
  expectedVersion: "7",
  idempotency: { key: "approve-order-123-request-42" },
});

if (result.status === "committed") {
  console.log(result.duplicate ? "Already applied" : "Approved");
  console.log(result.transition.id);
}
```

Event names and submitted inputs come from the lifecycle definition, so invalid
commands fail at compile time. Untyped callers still receive runtime
`unknown-event` and `invalid-input` results.

## Transition outcomes

`transition()` returns expected domain outcomes and throws operational failures:

| Outcome                | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `committed`            | The full transaction committed. `duplicate` identifies an idempotent replay. |
| `denied`               | Authorization, a guard, or the current source state rejected the command.    |
| `conflict`             | The resource no longer matches the expected version or state.                |
| `not-found`            | The primary resource does not exist.                                         |
| `idempotency-conflict` | The key was already used for a different command fingerprint.                |
| `invalid-input`        | Runtime input validation failed.                                             |
| `unknown-event`        | An untyped caller submitted an unknown event name.                           |

Operational and integration contract failures throw stable `InterlockError`
codes. Use `isInterlockError(error)` rather than relying on `instanceof` across
multiple physical package copies.

Handle every expected result explicitly:

```ts
switch (result.status) {
  case "committed":
    return result.duplicate ? "already-applied" : "applied";
  case "denied":
  case "conflict":
  case "not-found":
  case "idempotency-conflict":
  case "invalid-input":
  case "unknown-event":
    return result.status;
  default: {
    const exhaustive: never = result;
    return exhaustive;
  }
}
```

## How it works

Before opening a transaction, Interlock validates the command and computes its
idempotency fingerprint.

```mermaid
flowchart LR
  A["Validate command"] --> B["Begin transaction"]
  B --> C["Claim idempotency"]
  C --> D["Load and check resource"]
  D --> E["Apply primary and related writes"]
  E --> F["Append history and outbox"]
  F --> G["Complete idempotency"]
  G --> H["Commit"]
  C -. expected outcome .-> R["Rollback"]
  D -. expected outcome .-> R
  E -. failure .-> R
  F -. failure .-> R
```

Inside one driver-owned transaction it:

1. claims the idempotency key;
2. loads the primary resource;
3. rechecks authorization and guards;
4. prepares mutation, audit, and outbox data;
5. conditionally updates state and version;
6. applies related writes;
7. inserts append-only history and outbox rows;
8. completes idempotency and commits.

Bindings should normally return the updated resource directly from a conditional
`UPDATE ... RETURNING`. `hydrateBeforeCommit()` adds another database round trip
and is intended for joins, generated values, or projections that the primary
update cannot reasonably return.

If authorization and multiple guards need the same related data, memoize the
promise within that one assessment or transition rather than querying again:

```ts
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}
```

Rejected promises remain failures for that operation. Cross-request caching is
outside Interlock, and guards remain sequential for ordering and short-circuit
behavior.

For production latency, keep the application and PostgreSQL close, reuse one
warm `pg.Pool`, and size it for database capacity rather than incoming request
concurrency. Batch related writes in the binding, keep outbox payloads small,
and store references instead of large blobs when practical.

Expected outcomes after an idempotency claim force rollback before being
returned. A same-key duplicate returns the stored transition identity without
rerunning current policy or exposing a potentially unrelated current resource.
Historical duplicate edges are validated as stored history, not against the
current lifecycle graph, so a deployment may evolve an event without breaking
replay of an already committed key.

## PostgreSQL setup

`@interlock/postgres/migration.sql` creates the idempotency, transition-history,
and outbox tables in the active schema. Resolve and read the public SQL export:

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migration = await readFile(
  fileURLToPath(import.meta.resolve("@interlock/postgres/migration.sql")),
  "utf8",
);
```

The migration runs as one transaction in the active migration schema. The
runtime driver qualifies its own tables directly:

```ts
const driver = new PostgresDriver(pool, { schema: "interlock" });
```

Apply the migration with a transaction-local migration `search_path`; do not
change a shared pool's session setting. The migration targets clean
installations and does not upgrade older incompatible schemas.

Idempotent transitions are supported at `read committed` isolation. Interlock
rejects higher isolation levels for idempotent commands rather than advertising
an unproved concurrency algorithm.

## Packages

| Package                                          | Purpose                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| [`@interlock/core`](packages/core)               | Lifecycle definitions, typed commands, execution, and public contracts. |
| [`@interlock/postgres`](packages/postgres)       | Reference `pg` transaction driver and SQL migration.                    |
| [`@interlock/conformance`](packages/conformance) | Executable verification for drivers, bindings, and atomic rollback.     |

## Examples and guides

- [Runnable PostgreSQL example](examples/postgres-node/README.md)
- [PostgreSQL integration guide](docs/guides/postgres.md)
- [Idempotency model](docs/concepts/idempotency.md)
- [Transaction protocol](docs/architecture/transaction-protocol.md)
- [Lifecycle builder ADR](docs/adr/0001-explicit-typed-lifecycle-builder.md)

## Scope and guarantees

Interlock deliberately focuses on recording one domain transition correctly. It
does not execute workflows, schedule jobs, publish outbox messages, generate
APIs, or replace application-level database constraints. Outbox insertion is
atomic; external delivery remains the application's responsibility.

Applications must control direct writes to protected state and version columns.
Bindings must also document how related facts used by guards are stabilized. The
reference example demonstrates aggregate versioning for this purpose. For
database-enforced append-only history, deny application roles `UPDATE` and
`DELETE` privileges on `interlock_transition_history`.

A connection loss during commit reports `INTERLOCK_COMMIT_OUTCOME_UNKNOWN`.
Reconcile through stored idempotency and history data instead of blindly
retrying.

Interlock snapshots top-level command identity and JSON protocol values before
crossing asynchronous persistence boundaries. Actor values and parsed input are
application-owned references; parsers and callbacks must not mutate them after
returning.

Mutation, audit, outbox, history-actor, and history-metadata projections may be
synchronous or asynchronous. They run sequentially and all settle before the
primary write. Transactional reads are allowed; writes and external side effects
are not. Caller-initiated retries may evaluate them again.

## Compatibility

The `0.1.0-alpha.0` release tests:

- Node.js 22.14+ and 26;
- TypeScript 5.0+;
- PostgreSQL 16;
- `pg` 8.16.3 through 8.x.

Pre-1.0 APIs may change with changelog notice.

## Development

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm check

docker compose up -d --wait
TEST_DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock pnpm test:postgres

pnpm pack:check

TEST_DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock pnpm benchmark
```

Benchmark methodology and current maintainer measurements are recorded in
[docs/performance.md](docs/performance.md). Local Docker loopback results are
not production latency guarantees.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations and
[LAUNCH.md](LAUNCH.md) for the alpha release checklist.
