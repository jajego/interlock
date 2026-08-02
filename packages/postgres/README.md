# `@interlock/postgres`

Reference `pg` transaction driver plus the versioned Interlock idempotency,
history, and outbox schema. Apply the exported `migration.sql` before use.

```sh
pnpm add @interlock/core @interlock/postgres pg
```

Applications create the `pg` `Pool` and pass it to `new PostgresDriver(pool)`;
`pg` is a peer dependency so Interlock shares the application's pool package.

This package guarantees atomic insertion, not outbox delivery.
