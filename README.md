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
- `@interlock/conformance`: barriers and focused fault injection.

See [`examples/postgres-node`](examples/postgres-node) for a runnable lifecycle
with authorization, a related-document guard, authoritative row locking,
conditional `UPDATE ... RETURNING`, a related write, history, idempotency, and
outbox insertion.

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

## Development

```sh
pnpm install
pnpm build
pnpm check
docker compose up -d --wait
TEST_DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock pnpm test:postgres
```

The alpha targets Node.js 20+, TypeScript 5.9+, and PostgreSQL 16+. Statesman is
important prior art; Interlock's contribution is the combined transaction
protocol, not invention of persisted transitions or state guards.
