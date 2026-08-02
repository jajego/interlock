# Alpha launch checklist

## Repository

- [ ] Create or rename the public repository to `jajego/interlock`.
- [ ] Enable private vulnerability reporting before advertising that route.
- [ ] Confirm Actions, issue templates, license, governance, and support pages.
- [ ] Confirm CI passes on Node.js 22.14 and 26 with PostgreSQL 16.

## npm

- [ ] Confirm control of the `@interlock` npm scope.
- [ ] Review `pnpm pack:check` file lists and tarball sizes.
- [ ] Confirm trusted publishing/provenance for the release environment.
- [ ] Confirm npm CLI 11.5.1+ and publish alpha packages under `next`.
- [ ] Publish only through the reviewed release workflow.

## Announcement

- [ ] Lead with the single-transaction PostgreSQL guarantee and alpha status.
- [ ] Link the runnable example and document the read-committed idempotency
      limit.
- [ ] State that outbox delivery, workflow execution, and crash retries are out
      of scope.
- [ ] Invite focused binding, transaction, packaging, and documentation
      feedback.
- [ ] Link the
      [production-style Fastify + Prisma reference app](examples/reference-app/README.md),
      its [DX findings](examples/reference-app/docs/dx-findings.md), and
      [benchmark methodology](examples/reference-app/docs/benchmark-methodology.md).

## Draft: GitHub release

Interlock `0.1.0-alpha.0` is ready for early adopters. It gives one PostgreSQL
domain transition a single transaction boundary: the version-checked primary
update, related writes, append-only history, idempotency outcome, and outbox
records commit together or roll back together. The API is intentionally small,
TypeScript-first, and bring-your-own-SQL. Install with
`npm install @interlock/core@next @interlock/postgres@next pg`.

## Draft: short post

I built Interlock for PostgreSQL commands that are too important to partially
commit. It combines optimistic concurrency, policy checks, history, idempotency,
and transactional outbox insertion without introducing an ORM or workflow
engine. The first alpha is available under the npm `next` tag. Feedback on
bindings, failure semantics, and adoption friction is especially useful.

## Draft: technical forum

Interlock is a small TypeScript/PostgreSQL library for one narrow guarantee: a
domain command and every database record required to describe its outcome commit
in one transaction. It does not execute workflows or deliver outbox messages.
The repository includes ordinary-SQL bindings, real PostgreSQL race tests,
fault-injection conformance suites, and clean-package checks. I would value
review of the transaction protocol and idempotency semantics before 1.0.
