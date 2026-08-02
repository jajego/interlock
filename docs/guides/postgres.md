# PostgreSQL

Apply `@interlock/postgres/migration.sql`, keep application tables application
owned, and implement a binding whose conditional update checks both state and
version with `RETURNING`. Use `TEST_DATABASE_URL` for integration tests.

The same `PgTransaction` must reach application loads, context queries, primary
and related writes, idempotency, history, and outbox operations. The bundled
driver rejects use of its scoped handle after callback completion. Run the
public conformance functions against custom bindings or transaction hosts before
advertising compatibility.

The migration creates objects in the active schema and wraps a clean install in
one transaction. Use a dedicated schema or migration role with a deliberate
`search_path`. Existing incompatible tables are not upgraded in place.
