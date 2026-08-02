# Architecture

This document describes the implemented `0.1.0-alpha.0` protocol. The current
code and tests are authoritative; this document explains their intended shape.

## Product boundary

Interlock owns one PostgreSQL-backed domain transition. Its state-and-version
update, application-owned related writes, append-only history, idempotency
outcome, and outbox records commit together or roll back together.

Interlock is not a workflow runtime, scheduler, event-sourcing framework, ORM,
outbox publisher, retry worker, or statechart engine.

## Packages

- `@interlock/core` defines lifecycles, typed requests and results, protocol
  validation, and transaction sequencing. It has no runtime dependencies.
- `@interlock/postgres` supplies the reference `pg` transaction driver and SQL
  migration. Applications supply the pool.
- `@interlock/conformance` supplies executable driver, binding, and rollback
  checks using Node.js built-ins and core.

## Maintained sources of truth

- Code and tests define executable behavior.
- `README.md` is the adoption guide and quick start.
- `docs/architecture.md` describes protocol design.
- `docs/errors.md` defines operational error handling.
- `docs/performance.md` records measured performance behavior.

Documents under `docs/archive/` are historical and non-normative.

## Lifecycle model

A lifecycle names states and events. Each event has source states, one target
state, optional input parsing, authorization, sequential guards, and optional
mutation, audit, outbox, actor-identity, and history-metadata projections.
Self-transitions are rejected; ordinary writes that do not change lifecycle
state remain application code.

Event input and mutation types stay correlated. Projection callbacks may be
synchronous or asynchronous, run sequentially, and all settle before the first
write. Their frozen argument envelopes contain application-owned resource,
actor, context, and parsed-input references.

## Request and operation context

`assess()` and `transition()` snapshot each top-level request protocol field
before parsing or opening a transaction. JSON metadata is validated and
detached. Actor and parsed-input values remain application-owned references.

The immutable operation context carries mode, resource ID, event, actor,
metadata, correlation ID, and causation ID to transaction options, loading,
context creation, and writes. Authoritative write operations add the
event-correlated mutation.

## Transaction sequence

Before the transaction, Interlock snapshots the request, parses input, and
computes an idempotency fingerprint when configured. The driver then owns this
sequence:

1. begin the configured transaction;
2. claim idempotency, when requested;
3. load the primary resource;
4. verify resource identity, state, version, and expected version;
5. create context and repeat authorization and guards authoritatively;
6. construct and validate the complete mutation, audit, outbox, actor, metadata,
   transition, and outbox plan;
7. apply the state-and-version compare-and-swap update;
8. insert transition history;
9. apply application-owned related writes;
10. insert outbox rows;
11. complete idempotency;
12. optionally hydrate the resource, validate its boundary, and commit.

Every later failure rolls back every earlier write. History is inserted before
related writes so related rows may use an immediate foreign key to the history
row. The row is still uncommitted and disappears if any later stage fails.
History projections cannot depend on related-write output because planning is
complete before the primary update.

## Advisory assessment

`assess()` uses a read-only transaction and returns current advisory policy. It
does not reserve state. `transition()` repeats loading, authorization, and
guards inside its write transaction.

## Binding boundary

A `ResourceBinding` maps one application resource to a driver transaction. It
loads and identifies the resource, performs a conditional update checking both
source state and expected version, optionally writes related rows, optionally
hydrates before commit, and declares how related facts remain consistent.

Interlock validates loaded, applied, conflict, and hydrated postconditions.
Bindings own application SQL, locks, constraints, tenant handling, and any ORM
mapping. All application and Interlock writes must use the same scoped
transaction handle.

## Driver boundary

A `TransactionDriver` owns begin, commit, rollback, idempotency, history, and
outbox persistence. It must rethrow caller-controlled rollback values unchanged,
scope transaction handles to the callback, normalize operational failures, and
return stored transition history for duplicates. The PostgreSQL driver promotes
serialization, deadlock, lock-timeout, cancellation, and unknown-commit errors
to stable Interlock codes.

## Results and failures

Expected outcomes are values: committed, denied, conflict, not found, unknown
event, invalid input, idempotency conflict, and committed duplicate. Operational
failures throw `InterlockError`. Private denial message/details are validated
but never exposed in public results.

## Idempotency and duplicate replay

An idempotency key is scoped by lifecycle and globally unique resource ID. The
fingerprint covers application-selected command identity. Reusing a key with a
different fingerprint returns `idempotency-conflict`.

A matching committed key returns the stored transition without rerunning current
policy or loading the current resource. It does not return or hydrate current
resource state. Historical source and target states remain replayable after a
lifecycle definition evolves, while lifecycle, resource, event, key,
fingerprint, versions, timestamp, and optional public fields are validated.

Idempotent transitions support Read Committed only. Interlock rejects stronger
isolation rather than claiming an unproved race algorithm.

## Consistency and identifiers

The primary row is protected by state-and-version compare-and-swap. A binding
must declare how related facts used by authorization or guards are stabilized,
for example row locks, aggregate versions, dependency versions, serializable
isolation for non-idempotent commands, or database constraints.

Resource IDs must be globally unique within a lifecycle, including across
tenants. Namespace tenant-local IDs before passing them to Interlock.

## Outbox and history

Outbox insertion is atomic; delivery, retries, leasing, and publication are
application responsibilities. History is append-only by protocol. Database-level
immutability requires privileges or additional database controls that deny
updates and deletes.

## ORM transaction ownership

Raw `pg` is the first-party integration. An ORM can participate only through a
custom driver and binding that use one ORM-owned transaction handle for both
application and Interlock tables. The Prisma spike proves this composition; it
is not a published adapter or a claim of broad Prisma compatibility.

## Extension-point immutability

Interlock reads each property from request, callback, binding, and driver result
objects once, validates that local value, and constructs detached canonical
protocol snapshots. JSON values are copied. Generic actor, context, parsed
input, mutation, and resource values remain application-owned and must not be
mutated after their callback returns unless a documented callback explicitly
owns them.

## Intentionally unsupported

Interlock does not provide ambient transaction composition, automatic retries,
tenant columns, configurable table sets, workflow execution, durable timers,
sagas, hierarchical statecharts, event sourcing, generated APIs, adapters for
additional ORMs, or delivery workers.
