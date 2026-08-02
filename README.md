# Interlock

Interlock applies type-safe, atomic domain transitions to ordinary PostgreSQL
records. The version-checked resource update, related writes, immutable history,
idempotency outcome, and outbox messages commit together or do not happen.

Interlock is not a workflow engine, statechart runtime, ORM, event store, queue,
or exactly-once delivery system. Each transition owns one top-level database
transaction. Direct SQL can bypass a lifecycle; applications must control write
access to protected columns.

## Packages

- `@interlock/core`: definitions, assessment, planning, execution, and
  contracts;
- `@interlock/postgres`: the `pg` transaction driver and versioned SQL schema;
- `@interlock/conformance`: executable driver, binding, and executor atomicity
  verification suites.

## Install

```sh
pnpm add @interlock/core @interlock/postgres pg
```

`@interlock/core` has no external runtime dependencies. `pg` is a peer of
`@interlock/postgres`; applications create and own the `Pool` passed to
`new PostgresDriver(pool)`. Apply `@interlock/postgres/migration.sql` before
executing transitions.

See [`examples/postgres-node`](examples/postgres-node) for a runnable lifecycle
with authorization, a related-document guard, database-enforced aggregate
versioning, conditional `UPDATE ... RETURNING`, a related write, history,
idempotency, and outbox insertion.

```ts
const result = await applications.transition({
  id: "application-1",
  event: "approve",
  input: { note: "Ready" },
  actor: reviewer,
  expectedVersion: "7",
  idempotency: { key: "request-42" },
});

if (result.status === "committed" && !result.duplicate) {
  console.log(result.resource);
}
```

`assess()` is a read-only advisory check. It reserves nothing. `transition()`
rechecks policy authoritatively and commits. Optimistic concurrency protects the
primary row only; each binding documents how related facts are stabilized.

The PostgreSQL example uses aggregate versioning: document changes bump the
owning application's version, including both parents when a document is moved.
This detects related changes before lifecycle compare-and-swap; separate domain
constraints are still required to forbid later document changes after approval.

```ts
const assessment = await applications.assess({
  id: "application-1",
  event: "approve",
  input: { note: "Ready" },
  actor: reviewer,
});
```

Assessment has no idempotency key or expected version because it is not a write
precondition. Event names and submitted inputs are derived from the lifecycle's
schema map; unknown events and wrong input shapes fail compilation. Runtime
boundaries still return `unknown-event` or `invalid-input` for untyped callers.
Use `isInterlockError(error)` instead of relying on `instanceof` when package
managers may install more than one physical copy of `@interlock/core`.

## Transaction boundary

Request parsing and fingerprinting happen before a transaction. Inside one
driver-owned transaction Interlock claims idempotency, loads and authoritatively
assesses the resource, creates and validates the complete plan, conditionally
updates state and version, applies related writes, inserts history and outbox
rows, completes idempotency, and commits. Expected denial, absence, and CAS
conflict outcomes after a claim force rollback before becoming result values.

Duplicate keys with the same fingerprint return the stored transition identity
without rerunning current authorization or exposing the current resource. A
different fingerprint, including a different expected version, returns
`idempotency-conflict`. No leases, polling, expiry, or durable in-progress state
exist.

## PostgreSQL schema

`@interlock/postgres/migration.sql` creates:

- `interlock_idempotency`, containing same-transaction claims and completions;
- `interlock_transition_history`, an append-only audit record;
- `interlock_outbox`, containing messages to publish after commit.

Interlock guarantees outbox insertion, not broker delivery, ordering,
dead-letter handling, consumer idempotency, or exactly-once processing. The
reference application uses a database trigger to increment the primary
application version for every relevant document insert, update, or delete. The
approval CAS therefore fails if guard dependencies change before its update.

## Development

```sh
pnpm install
pnpm build
pnpm check
docker compose up -d --wait
TEST_DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock pnpm test:postgres
TEST_DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock pnpm --filter @interlock/prisma-postgres-spike start
pnpm pack:check
```

The `0.1.0-alpha.0` release targets Node.js 20+, TypeScript 5.9+, PostgreSQL
16+, and `pg` 8.16.3 through 8.x. Pre-1.0 APIs may change with changelog notice.
Publishing also requires control of the npm `@interlock` scope. Statesman is
important prior art; Interlock's contribution is the combined transaction
protocol, not invention of persisted transitions or state guards.
