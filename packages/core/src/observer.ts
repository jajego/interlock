import type { InterlockErrorCode } from "./errors.js";

interface InterlockOperationBase {
  readonly operationId: string;
  readonly mode: "assess" | "transition";
  readonly lifecycle: string;
  readonly resourceId: string;
  readonly event: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

interface InterlockOperationStarted extends InterlockOperationBase {
  readonly type: "interlock.operation.started";
}

interface InterlockOperationCompleted extends InterlockOperationBase {
  readonly type: "interlock.operation.completed";
  readonly outcome:
    | "allowed"
    | "committed"
    | "duplicate"
    | "denied"
    | "conflict"
    | "not-found"
    | "invalid-input"
    | "unknown-event"
    | "idempotency-conflict";
  readonly transitionId?: string;
  readonly durationMs: number;
  /** Present only when the driver entered its transaction callback. */
  readonly transactionDurationMs?: number;
  readonly outboxMessageCount?: number;
}

interface InterlockOperationFailed extends InterlockOperationBase {
  readonly type: "interlock.operation.failed";
  readonly code: InterlockErrorCode;
  readonly phase:
    | "request"
    | "transaction"
    | "idempotency"
    | "load-primary"
    | "context"
    | "assessment"
    | "planning"
    | "primary-write"
    | "history"
    | "related-writes"
    | "outbox"
    | "idempotency-completion"
    | "hydration"
    | "commit"
    | "result";
  readonly commitOutcome: "not-started" | "not-committed" | "unknown";
  readonly durationMs: number;
  /** Present only when the driver entered its transaction callback. */
  readonly transactionDurationMs?: number;
}

/**
 * Structural, non-durable metadata emitted for one Interlock operation.
 * Observations contain no raw input, actor, resource, payload, or error values.
 */
export type InterlockObservation =
  | InterlockOperationStarted
  | InterlockOperationCompleted
  | InterlockOperationFailed;

/**
 * Optional best-effort operational telemetry sink. Interlock calls it outside
 * the transaction, never awaits it, and ignores exceptions and rejections.
 * Synchronous observer work still adds caller-visible latency.
 */
export interface InterlockObserver {
  observe(observation: InterlockObservation): void;
}
