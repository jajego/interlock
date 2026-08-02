# Interlock

[![CI](https://github.com/jajego/interlock/actions/workflows/ci.yml/badge.svg)](https://github.com/jajego/interlock/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@interlock/core?label=npm)](https://www.npmjs.com/package/@interlock/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Type-safe, atomic lifecycle transitions for PostgreSQL.**

Interlock gives important domain changes one dependable transaction boundary.
Your version-checked resource update, related writes, immutable history,
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
- **Built-in audit trail:** every committed transition has an immutable record.
- **Retry-friendly APIs:** idempotency keys return the original committed
  transition instead of applying it twice.
- **PostgreSQL-native:** bring your own `pg` pool and write ordinary SQL against
  ordinary application tables.
- **Small footprint:** `@interlock/core` has zero external runtime dependencies.

## Install

```sh
npm install @interlock/core @interlock/postgres pg
```

Your application owns the `pg` `Pool`. The PostgreSQL package imports `pg` only
as a type and declares it as a peer dependency.

## Quick start

### 1. Define a lifecycle

```ts
import { defineLifecycle, deny } from "@interlock/core";

interface Order {
  id: string;
  state: string;
  version: string;
}

interface Actor {
  id: string;
  canApprove: boolean;
}

const orderLifecycle = defineLifecycle<
  Order,
  Actor,
  Record<string, never>,
  { approvedBy: string }
>()({
  name: "order",
  states: ["pending", "approved"],
  history: {
    resourceType: "order",
    actor: (actor) => ({ actorType: "user", actorId: actor.id }),
  },
  events: {
    approve: {
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
    },
  },
});
```

### 2. Connect your table

A resource binding maps Interlock's transaction protocol to your existing
tables. Its primary update uses normal conditional SQL:

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
does not reserve or guarantee the transition.

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

## How it works

Before opening a transaction, Interlock validates the command and computes its
idempotency fingerprint. Inside one driver-owned transaction it:

1. claims the idempotency key;
2. loads the primary resource;
3. rechecks authorization and guards;
4. prepares mutation, audit, and outbox data;
5. conditionally updates state and version;
6. applies related writes;
7. inserts immutable history and outbox rows;
8. completes idempotency and commits.

Expected outcomes after an idempotency claim force rollback before being
returned. A same-key duplicate returns the stored transition identity without
rerunning current policy or exposing a potentially unrelated current resource.

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

The migration runs as one transaction and targets clean installations; it does
not upgrade older incompatible Interlock schemas. Use a deliberate PostgreSQL
schema and `search_path`.

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
reference example demonstrates aggregate versioning for this purpose.

A connection loss during commit reports `INTERLOCK_COMMIT_OUTCOME_UNKNOWN`.
Reconcile through stored idempotency and history data instead of blindly
retrying.

Interlock snapshots top-level command identity and JSON protocol values before
crossing asynchronous persistence boundaries. Actor values and parsed input are
application-owned references; parsers and callbacks must not mutate them after
returning.

## Compatibility

The `0.1.0-alpha.0` release tests:

- Node.js 26+;
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
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations and
[LAUNCH.md](LAUNCH.md) for the alpha release checklist.
