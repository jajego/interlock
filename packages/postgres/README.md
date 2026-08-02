# `@interlock/postgres`

Reference `pg` transaction driver plus the versioned Interlock idempotency,
history, and outbox schema. Apply the exported `migration.sql` before use.

This package guarantees atomic insertion, not outbox delivery.
