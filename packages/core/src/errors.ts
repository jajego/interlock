/** Stable codes for unexpected operational failures and integration violations. */
export type InterlockErrorCode =
  | "INTERLOCK_DEFINITION_INVALID"
  | "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION"
  | "INTERLOCK_DRIVER_UNSUPPORTED"
  | "INTERLOCK_DRIVER_PROTOCOL_VIOLATION"
  | "INTERLOCK_BINDING_PROTOCOL_VIOLATION"
  | "INTERLOCK_TRANSACTION_FAILED"
  | "INTERLOCK_PERSISTENCE_FAILED"
  | "INTERLOCK_SERIALIZATION_FAILED"
  | "INTERLOCK_SERIALIZATION_CONFLICT"
  | "INTERLOCK_DEADLOCK"
  | "INTERLOCK_LOCK_TIMEOUT"
  | "INTERLOCK_COMMIT_OUTCOME_UNKNOWN"
  | "INTERLOCK_OUTBOX_FAILED"
  | "INTERLOCK_HISTORY_FAILED"
  | "INTERLOCK_VERSION_EXHAUSTED"
  | "INTERLOCK_CANCELLED";

const interlockErrorBrand = Symbol.for("@interlock/core/InterlockError");

/**
 * An operational failure or protocol violation thrown by Interlock.
 * Expected domain outcomes such as denial, conflict, invalid input, and
 * not-found are returned as result values instead.
 */
export class InterlockError extends Error {
  readonly [interlockErrorBrand] = true;

  constructor(
    readonly code: InterlockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InterlockError";
  }
}

/**
 * The supported runtime check for Interlock failures. It remains reliable when
 * duplicated package copies or JavaScript realms make `instanceof` unreliable.
 */
export function isInterlockError(value: unknown): value is InterlockError {
  if (!(value instanceof Error)) return false;
  const candidate = value as Error & {
    code?: unknown;
    [interlockErrorBrand]?: unknown;
  };
  return (
    candidate[interlockErrorBrand] === true ||
    (candidate.name === "InterlockError" &&
      typeof candidate.code === "string" &&
      candidate.code.startsWith("INTERLOCK_"))
  );
}
