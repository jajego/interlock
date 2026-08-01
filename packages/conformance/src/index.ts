import type { TransactionDriver } from "@interlock/core";

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

export function failOperation<Transaction>(
  driver: TransactionDriver<Transaction>,
  operation: "history" | "outbox" | "idempotency-completion",
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
