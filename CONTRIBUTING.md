# Contributing

Use Node.js 24+, pnpm 11.18, and PostgreSQL 16. Before submitting a pull
request, run:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm test
node --test integration/core.test.mjs
pnpm check
docker compose up -d --wait
TEST_DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock pnpm test:postgres
pnpm pack:check
```

Public API or transaction-semantics changes require a short ADR and a Changeset.
Protocol claims require real PostgreSQL tests; mocks may cover pure planning but
cannot substantiate commit, rollback, locking, or race behavior. Keep changes
within the documented alpha scope and avoid speculative extension points.
