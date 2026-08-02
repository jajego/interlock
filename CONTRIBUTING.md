# Contributing

Published packages support Node.js 22.14 and newer. Repository development,
Prisma generation, the complete reference app, and the primary CI and release
workflows use Node.js 26; contributors should use the exact version in `.nvmrc`.
CI also runs the lightweight package build, type, and non-database test suite on
Node.js 22.14 to preserve the minimum compatibility target.

Use pnpm 11.18 and PostgreSQL 16. Before submitting a pull request, run:

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
