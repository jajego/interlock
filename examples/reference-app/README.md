# Interlock reference app

A committed production-style permit-approval backend showing Interlock in a
Fastify, Prisma, PostgreSQL 16 application. It demonstrates multitenant
authentication, typed lifecycle commands, optimistic concurrency, idempotency,
history, related writes, transactional outbox insertion, and a deliberately
limited local outbox worker. It is an external-consumer and DX evaluation, not a
production starter kit or published Prisma adapter.

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

The HTTP membership lookup is an authentication precheck only. Every transition
re-reads and row-locks the active tenant membership inside the Prisma
transaction. Submission loads only its document count; document writes bump the
permit aggregate version, and reassignment bumps both source and destination.
The submission CAS therefore rejects a document snapshot made stale by a move.
Approval and rejection lock the current assignment. Beginning review locks the
selected candidate's active membership and requires a reviewer or admin role.
Other events do not pay for those unrelated reads. The previous decorative
transaction-local tenant/user settings were removed because the schema has no
RLS policy consuming them.

Operational failures return a stable Interlock code, generic message, and
request ID. Full errors and cause chains are written only to structured server
logs. Expected denials retain public details while private denial fields remain
hidden.

Prisma needs a custom driver because Interlock must use the same interactive
transaction handle for application and artifact writes. Runtime code never opens
an independent `pg` transaction; `pg` is used only by migration setup. This app
deliberately omits a frontend, real identity provider, broker, deployment
configuration, automatic retries, and a reusable Prisma adapter.

The copyable driver batches outbox rows in parameterized groups of 500, verifies
history/outbox affected-row counts, and normalizes PostgreSQL serialization,
deadlock, lock-timeout, cancellation, and unknown-commit failures through the
public PostgreSQL normalizer. Prisma-specific unique errors remain generic
transaction failures; this example does not claim complete error parity with the
first-party `pg` driver.

The worker intentionally holds `FOR UPDATE SKIP LOCKED` and the database
transaction open while `deliver()` runs. Slow network delivery therefore
lengthens the transaction. External delivery may succeed before the database
acknowledgement fails, so delivery is at-least-once. Production dispatchers
commonly use a lease/claim design; this compact worker demonstrates exclusion
and retryability, not distributed delivery architecture.

See [DX findings](docs/dx-findings.md) and
[benchmark methodology](docs/benchmark-methodology.md).
