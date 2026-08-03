# PostgreSQL

Apply `@jajego/interlock-postgres/migration.sql`, keep application tables
application owned, and implement a binding whose conditional update checks both
state and version with `RETURNING`. Use `TEST_DATABASE_URL` for integration
tests.

Resource IDs must be globally unique within each lifecycle. If application IDs
are tenant-local, namespace them before passing them to Interlock or use
globally unique primary keys; the current persistence schema has no tenant scope
column.

The same `PgTransaction` must reach application loads, context queries, primary
and related writes, idempotency, history, and outbox operations. The bundled
driver rejects use of its scoped handle after callback completion. Run the
public conformance functions against custom bindings or transaction hosts before
advertising compatibility.

Raw `pg` is the first-party path. ORMs that own their transaction handles need a
custom `TransactionDriver`; the Prisma spike is a copyable proof, not a drop-in
adapter.

For a complete application integration, see the committed
[Fastify + Prisma reference app](../../examples/reference-app/README.md), its
[DX findings](../../examples/reference-app/docs/dx-findings.md), and
[benchmark methodology](../../examples/reference-app/docs/benchmark-methodology.md).

Prefer a conditional `UPDATE ... RETURNING` that returns the committed resource
from `applyPrimary()`. `hydrateBeforeCommit()` is available when joins,
generated values, or projections require a separate read, but it adds one
database round trip and should not be enabled automatically.

Authorization and sequential guards may share a request-scoped promise:

```ts
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}
```

Create it inside one context factory call. A rejected promise remains a failure
for that operation; do not turn it into a global or cross-request cache.

Keep PostgreSQL in the same region or availability zone as the application and
reuse one warm `pg.Pool`. Size the pool against measured database capacity, not
HTTP concurrency. Bindings should batch related writes where ordinary SQL can do
so, and outbox messages should normally reference large blobs rather than
embedding them.

The migration creates objects in the active migration schema. Configure runtime
qualification once with `new PostgresDriver(pool, { schema: "interlock" })`. On
a dedicated migration connection, create the schema, set that connection's
session `search_path`, and execute the exported self-transactional migration.
Never alter a shared runtime pool's session setting. Existing incompatible
tables are not upgraded in place.

Interlock inserts transition history before `applyRelated()`, so related tables
may use an immediate foreign key to `interlock_transition_history(id)`. Every
row remains uncommitted until the whole transition succeeds.
