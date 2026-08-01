# PostgreSQL

Apply `@interlock/postgres/migration.sql`, keep application tables application
owned, and implement a binding whose conditional update checks both state and
version with `RETURNING`. Use `TEST_DATABASE_URL` for integration tests.
