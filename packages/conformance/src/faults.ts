import type { TransactionDriver } from "@interlock/core";

/** Persistence operation that can be replaced with an injected test failure. */
export type FaultOperation = "history" | "outbox" | "idempotency-completion";

/**
 * Wraps a driver so one selected persistence operation throws the supplied
 * error. Intended only for deterministic failure and rollback tests.
 */
export function failOperation<Transaction>(
  driver: TransactionDriver<Transaction>,
  operation: FaultOperation,
  error: Error,
): TransactionDriver<Transaction> {
  return {
    transaction: driver.transaction.bind(driver),
    claimIdempotency: driver.claimIdempotency.bind(driver),
    completeIdempotency:
      operation === "idempotency-completion"
        ? async () => {
            throw error;
          }
        : driver.completeIdempotency.bind(driver),
    insertTransition:
      operation === "history"
        ? async () => {
            throw error;
          }
        : driver.insertTransition.bind(driver),
    insertOutbox:
      operation === "outbox"
        ? async () => {
            throw error;
          }
        : driver.insertOutbox.bind(driver),
  };
}

/**
 * Creates a deterministic one-shot test barrier. Each participant waits until
 * `size` arrivals release all waiters; the returned barrier is not reusable.
 */
export function barrier(size: number): () => Promise<void> {
  let waiting = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    waiting += 1;
    if (waiting === size) release?.();
    await ready;
  };
}
