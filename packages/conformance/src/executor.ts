import assert from "node:assert/strict";
import { isInterlockError, type TransactionDriver } from "@interlock/core";
import { failOperation, type FaultOperation } from "./faults.js";

export interface ExecutorAtomicityConformance<Transaction> {
  driver: TransactionDriver<Transaction>;
  reset(): Promise<void>;
  transition(driver: TransactionDriver<Transaction>): Promise<unknown>;
  snapshot(): Promise<{
    primaryVersion: string;
    related: number;
    history: number;
    outbox: number;
    idempotency: number;
  }>;
}

export async function verifyExecutorAtomicity<Transaction>(
  fixture: ExecutorAtomicityConformance<Transaction>,
): Promise<void> {
  for (const operation of [
    "history",
    "outbox",
    "idempotency-completion",
  ] as const satisfies readonly FaultOperation[]) {
    await fixture.reset();
    const baseline = await fixture.snapshot();
    const driver = failOperation(
      fixture.driver,
      operation,
      new Error(`injected ${operation} failure`),
    );
    const expectedCode = {
      history: "INTERLOCK_HISTORY_FAILED",
      outbox: "INTERLOCK_OUTBOX_FAILED",
      "idempotency-completion": "INTERLOCK_PERSISTENCE_FAILED",
    }[operation];
    await assert.rejects(
      fixture.transition(driver),
      (error) => isInterlockError(error) && error.code === expectedCode,
    );
    assert.deepEqual(await fixture.snapshot(), baseline);
  }
}
