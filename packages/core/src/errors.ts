export type InterlockErrorCode =
  | "INTERLOCK_DEFINITION_INVALID"
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
  | "INTERLOCK_CANCELLED";

export class InterlockError extends Error {
  constructor(
    readonly code: InterlockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InterlockError";
  }
}
