# PostgreSQL example

This example owns an isolated `interlock_example` schema. It demonstrates a
read-only assessment, one committed approval, a same-key duplicate, a stale
version conflict, a related write, append-only history, and an outbox row.

```sh
docker compose up -d --wait
$env:TEST_DATABASE_URL="postgresql://interlock:interlock@localhost:54329/interlock"
pnpm build
pnpm --filter @interlock/example-postgres-node run setup
pnpm --filter @interlock/example-postgres-node run start
```

The setup command drops only `interlock_example`. Do not point it at a database
where that schema contains data you need.
