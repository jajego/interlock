# Changelog

## Unreleased

## 0.1.0-alpha.0 — 2026-08-02

- Prepared `0.1.0-alpha.0` as the first public alpha.
- Added typed lifecycle commands, optimistic concurrency, idempotent replay,
  append-only transition history, transactional outbox records, PostgreSQL
  integration, conformance suites, and clean-package verification.
- Alpha packages publish under the npm `next` dist-tag.
- Batched PostgreSQL outbox inserts, combined JSON validation and defensive
  snapshots with lazy error-path formatting, deterministic query-count checks,
  and reproducible performance evaluation scripts.
- Replaced the pre-alpha binding API with immutable operation context,
  event-correlated mutations, safe transaction and context defaults, singular
  structured denials, asynchronous planning support, a named client type,
  curated exports, and schema-qualified PostgreSQL tables.
- Made actor and idempotency request fields reflect lifecycle capabilities,
  accepted ordinary version strings from bindings, constrained event states, and
  added operation-aware projections plus derived binding/client types.
- Hardened protocol boundaries with own-property event lookup, immutable
  callback envelopes, immediate history and outbox snapshots,
  event-discriminated fingerprints, explicit unsupported-idempotency results,
  and validated consistency declarations.
- Eliminated repeated reads from request, callback, binding, and driver result
  objects; transition history now precedes related writes so immediate foreign
  keys can reference the planned transition inside the same transaction.
- Replaced the stale root design proposal with maintained alpha architecture
  documentation and added focused public API hover documentation across the
  core, PostgreSQL, and conformance packages.
- Added an optional dependency-free, best-effort observer API with
  started/completed/failed observations, expected-outcome and failure-phase
  metadata, and monotonic total and transaction durations. Durable transition
  history remains limited to committed transitions and no schema changed.
