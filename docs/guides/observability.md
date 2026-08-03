# Observability

Interlock exposes two complementary records:

- transition history is durable application data for committed domain
  transitions;
- observations are best-effort operational telemetry for attempts, expected
  outcomes, failures, phases, and timing.

Observations are not persisted, retried, or delivered exactly once. Interlock
does not bundle a logger, metrics registry, tracing SDK, or telemetry backend.

## Observer setup

```ts
import { createInterlock, type InterlockObserver } from "@jajego/interlock";

const observer: InterlockObserver = {
  observe(observation) {
    console.info(observation);
  },
};

const client = createInterlock({ lifecycle, binding, driver, observer });
```

Interlock captures `observer.observe` once during client construction and binds
it to the observer object. Object methods and class methods using private fields
therefore retain their receiver.

Each callback receives a frozen, detached, plain-data object. Interlock invokes
callbacks only outside its database transaction, ignores synchronous exceptions,
never awaits returned promises or thenables, and consumes their rejections. A
failed callback is not retried and does not produce another observation.

Synchronous work still adds caller-visible latency. An observer should enqueue,
increment, or record lightweight in-process telemetry. It should not perform
network or filesystem work directly.

## Event model

Every observed operation starts with:

```ts
{
  type: "interlock.operation.started",
  operationId,
  mode: "assess" | "transition",
  lifecycle,
  resourceId,
  event,
  correlationId?,
  causationId?,
}
```

`operationId` is a fresh internal UUID allocated only when an observer is
configured. It is reused by the terminal observation and is distinct in purpose
from the durable `transitionId`. Malformed top-level requests that cannot safely
provide string resource and event identity may fail before observation begins.

Every emitted start is followed by exactly one attempted terminal observation:

- `interlock.operation.completed` for expected results;
- `interlock.operation.failed` for thrown operational failures.

Observer failure can drop either callback because delivery is best-effort, but
it cannot change Interlock's result or prevent the terminal callback attempt.

## Completed outcomes

```ts
{
  type: "interlock.operation.completed",
  // shared identity fields
  outcome,
  transitionId?,
  durationMs,
  transactionDurationMs?,
  outboxMessageCount?,
}
```

| Public result                           | Outcome                |
| --------------------------------------- | ---------------------- |
| successful assessment                   | `allowed`              |
| newly committed transition              | `committed`            |
| committed duplicate replay              | `duplicate`            |
| authorization, guard, or state denial   | `denied`               |
| version or conditional-write conflict   | `conflict`             |
| missing primary resource                | `not-found`            |
| input or request validation rejection   | `invalid-input`        |
| unknown lifecycle event                 | `unknown-event`        |
| reused key with a different fingerprint | `idempotency-conflict` |

`transitionId` is present for `committed` and `duplicate`. A newly committed
transition reports its planned `outboxMessageCount`, including zero. Duplicate
replay does not claim knowledge of the original count.

`transactionDurationMs` is present when the driver transaction call began and
covers acquisition, execution, commit, or rollback. `durationMs` covers the
whole observed operation. Both use a monotonic clock and are finite, nonnegative
millisecond values.

## Operational failures

```ts
{
  type: "interlock.operation.failed",
  // shared identity fields
  code,
  phase,
  commitOutcome: "not-started" | "not-committed" | "unknown",
  durationMs,
  transactionDurationMs?,
}
```

The stable phases are:

| Phase                    | Boundary                                              |
| ------------------------ | ----------------------------------------------------- |
| `request`                | request parsing, normalization, or fingerprinting     |
| `transaction`            | transaction options, acquisition, or setup            |
| `idempotency`            | claim, conflict, or duplicate validation              |
| `load-primary`           | primary-resource load and loaded boundary             |
| `context`                | request-scoped context construction                   |
| `assessment`             | state, authorization, and guard evaluation            |
| `planning`               | mutation, audit, metadata, actor, and outbox planning |
| `primary-write`          | conditional primary update and postcondition          |
| `history`                | transition-history insertion                          |
| `related-writes`         | application-owned related writes                      |
| `outbox`                 | transactional-outbox insertion                        |
| `idempotency-completion` | linking the successful claim to history               |
| `hydration`              | optional pre-commit resource hydration                |
| `commit`                 | driver commit after operation work completed          |
| `result`                 | final returned-resource or result validation          |

`not-started` means the driver never entered the transaction callback.
`not-committed` means Interlock knows the transaction did not commit. `unknown`
is reserved for `INTERLOCK_COMMIT_OUTCOME_UNKNOWN`; reconcile through durable
idempotency and history before retrying.

The failed observation deliberately excludes the raw error, message, cause,
stack, SQL, constraints, connection data, and request values. Applications may
log the separately thrown `InterlockError` under their own security policy.

## Safe logs and metrics

Observations use an explicit allowlist. They never contain raw input, parsed
input, actor or resource objects, mutations, audit data, history metadata,
denial details, outbox payloads, idempotency keys, fingerprints, transaction
handles, or errors.

Resource, operation, transition, correlation, and causation IDs may be useful
structured log or trace attributes when allowed by application policy. They are
unbounded and must not be metric labels. Actor IDs and idempotency keys are not
observed at all.

Useful low-cardinality metrics include:

```text
interlock_operation_total{mode,lifecycle,event,outcome}
interlock_operation_duration_seconds{mode,lifecycle,event}
interlock_transaction_duration_seconds{mode,lifecycle,event}
interlock_operational_error_total{lifecycle,event,code,phase}
interlock_duplicate_total{lifecycle,event}
interlock_idempotency_conflict_total{lifecycle,event}
interlock_unknown_commit_total{lifecycle,event}
```

Database and outbox workers should separately report operational state such as:

```text
interlock_outbox_pending
interlock_outbox_oldest_pending_seconds
interlock_history_insert_failure_total
```

Those measurements come from the database or worker, not the observer. Interlock
inserts outbox rows atomically but does not publish or monitor them.

## Tracing adapter

No tracing dependency is required. An application can adapt local interfaces:

```ts
interface Span {
  setAttributes(attributes: Record<string, string | number>): void;
  end(): void;
}

interface Tracer {
  startSpan(name: string, attributes: Record<string, string>): Span;
}

function tracingObserver(tracer: Tracer): InterlockObserver {
  const spans = new Map<string, Span>();
  return {
    observe(observation) {
      if (observation.type === "interlock.operation.started") {
        spans.set(
          observation.operationId,
          tracer.startSpan("interlock.operation", {
            mode: observation.mode,
            lifecycle: observation.lifecycle,
            event: observation.event,
          }),
        );
        return;
      }
      const span = spans.get(observation.operationId);
      if (!span) return;
      span.setAttributes(
        observation.type === "interlock.operation.completed"
          ? { outcome: observation.outcome, durationMs: observation.durationMs }
          : {
              code: observation.code,
              phase: observation.phase,
              commitOutcome: observation.commitOutcome,
            },
      );
      span.end();
      spans.delete(observation.operationId);
    },
  };
}
```

Because delivery is best-effort, adapters must tolerate a missing start or
terminal callback and clean up abandoned local state independently.

## Durable auditing boundary

Transition history records successfully committed domain transitions. Its
implemented fields include transition ID, lifecycle, resource type and ID,
event, previous and next state, previous and next version, optional actor type
and ID, projected audit data and metadata, correlation and causation IDs,
optional idempotency identity and request fingerprint, definition version, and
occurrence time.

History is append-only by protocol. Stronger immutability requires database
privileges or additional controls that deny updates and deletes. Raw request
input is not stored automatically. Denied, invalid, conflicting, and failed
attempts are not transition history; compliance-sensitive applications may need
a separate access-attempt log under their own retention and privacy policy.

Interlock is not an event store and does not provide tamper-evident signatures,
retention management, telemetry persistence, retry queues, dashboards, alerting,
or a hosted observability service.
