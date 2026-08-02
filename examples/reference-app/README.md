# Interlock reference app

A deliberately small permit-approval backend showing Interlock in a Fastify,
Prisma, PostgreSQL 16 application. It demonstrates multitenant authentication,
typed lifecycle commands, optimistic concurrency, idempotency, history, related
writes, transactional outbox insertion, and a safe local outbox worker.

```mermaid
flowchart LR
  HTTP["HTTP request"] --> Auth["membership authentication"]
  Auth --> Service["permit service"] --> Interlock
  Interlock --> Tx["Prisma interactive transaction"]
  Tx --> App["application tables"]
  Tx --> Artifacts["Interlock history / idempotency / outbox"]
  App --> Commit["commit"]
  Artifacts --> Commit --> Worker["outbox worker"] --> Delivery["delivered_notifications"]
```

## Prerequisites

- Node.js 26+
- pnpm 11.18+
- PostgreSQL 16; the repository Docker service uses port `54329`

Environment variables: `DATABASE_URL` (required), `HOST` (default `127.0.0.1`),
`PORT` (default `3100`), and `BODY_LIMIT_BYTES` (default `65536`).

## Setup

Bash:

```sh
docker compose up -d --wait
export DATABASE_URL=postgres://interlock:interlock@localhost:54329/interlock_reference
pnpm --filter @interlock/reference-app generate
pnpm --filter @interlock/reference-app migrate
pnpm --filter @interlock/reference-app seed
pnpm --filter @interlock/reference-app build
pnpm --filter @interlock/reference-app start
```

PowerShell:

```powershell
docker compose up -d --wait
$env:DATABASE_URL='postgres://interlock:interlock@localhost:54329/interlock_reference'
pnpm --filter @interlock/reference-app generate
pnpm --filter @interlock/reference-app migrate
pnpm --filter @interlock/reference-app seed
pnpm --filter @interlock/reference-app build
pnpm --filter @interlock/reference-app start
```

Run one transition:

```sh
curl -X POST http://127.0.0.1:3100/permits \
  -H 'content-type: application/json' -H 'x-tenant-id: tenant-a' \
  -H 'x-user-id: applicant-a' \
  -d '{"permitNumber":101,"applicantName":"Avery"}'
curl -X POST http://127.0.0.1:3100/permits/PERMIT_ID/events/cancel \
  -H 'content-type: application/json' -H 'x-tenant-id: tenant-a' \
  -H 'x-user-id: applicant-a' -H 'expected-version: 1' \
  -H 'idempotency-key: cancel-101' -d '{"reason":"Withdrawn"}'
```

Expected success is `200` with `status: "committed"`; retries return the same
transition with `duplicate: true`. Denials are `403`, invalid input `400`, stale
versions and reused keys `409`, missing resources `404`, and operational
`InterlockError` failures `500` with a stable public code.

## Commands

```sh
pnpm --filter @interlock/reference-app test
pnpm --filter @interlock/reference-app worker
pnpm --filter @interlock/reference-app benchmark:cpu
pnpm --filter @interlock/reference-app benchmark:database
pnpm --filter @interlock/reference-app benchmark:http
pnpm --filter @interlock/reference-app verify:packed
```

Tests reset application and Interlock tables in the configured test database.
The packed verifier creates and drops its own temporary database. To reset the
manual environment, drop the database or run migrations against a fresh one.

## Code ownership

- `domain/permits/lifecycle.ts` is domain policy and projections.
- `domain/permits/binding.ts` maps permit tables and related writes.
- `interlock/prisma-driver.ts` is generic Prisma/PostgreSQL protocol plumbing.
- `workers/outbox.ts` is application delivery policy. It provides at-least-once
  attempts, not exactly-once external delivery.

Prisma needs a custom driver because Interlock must use the same interactive
transaction handle for application and artifact writes. Runtime code never opens
an independent `pg` transaction; `pg` is used only by migration setup. This app
deliberately omits a frontend, real identity provider, broker, deployment
configuration, automatic retries, and a reusable Prisma adapter.

See [DX findings](docs/dx-findings.md) and
[benchmark methodology](docs/benchmark-methodology.md).
