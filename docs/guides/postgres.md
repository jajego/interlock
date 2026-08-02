# PostgreSQL

Apply `@interlock/postgres/migration.sql`, keep application tables application
owned, and implement a binding whose conditional update checks both state and
version with `RETURNING`. Use `TEST_DATABASE_URL` for integration tests.

The same `PgTransaction` must reach application loads, context queries, primary
and related writes, idempotency, history, and outbox operations. The bundled
driver rejects use of its scoped handle after callback completion. Run the
public conformance functions against custom bindings or transaction hosts before
advertising compatibility.

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

The migration creates objects in the active schema and wraps a clean install in
one transaction. Use a dedicated schema or migration role with a deliberate
`search_path`. Existing incompatible tables are not upgraded in place.
