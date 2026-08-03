import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setImmediate } from "node:timers";
import {
  InterlockError,
  isInterlockError,
} from "../../packages/core/dist/index.js";
import {
  executorFixture,
  transitionRequest,
  validDuplicate,
} from "./fixture.mjs";

const sharedKeys = [
  "event",
  "lifecycle",
  "mode",
  "operationId",
  "resourceId",
  "type",
];
const prohibitedKeys = new Set([
  "input",
  "parsedInput",
  "actor",
  "resource",
  "previousResource",
  "updatedResource",
  "mutation",
  "auditData",
  "metadata",
  "publicDetails",
  "privateDetails",
  "privateMessage",
  "outbox",
  "payload",
  "idempotencyKey",
  "fingerprint",
  "requestFingerprint",
  "error",
  "cause",
  "message",
  "stack",
  "transaction",
]);

function keys(value) {
  return Object.keys(value).sort();
}

function assertSafe(value) {
  for (const [key, item] of Object.entries(value)) {
    assert.equal(prohibitedKeys.has(key), false, key);
    if (item && typeof item === "object") assertSafe(item);
  }
}

function assertPair(
  observations,
  { mode, outcome, transaction, transition, outbox },
) {
  assert.equal(observations.length, 2);
  const [started, completed] = observations;
  assert.equal(started.type, "interlock.operation.started");
  assert.equal(completed.type, "interlock.operation.completed");
  assert.equal(started.mode, mode);
  assert.equal(completed.mode, mode);
  assert.equal(completed.outcome, outcome);
  assert.equal(started.operationId, completed.operationId);
  assert.match(started.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(Object.isFrozen(started), true);
  assert.equal(Object.isFrozen(completed), true);
  assert.deepEqual(keys(started), sharedKeys);
  assert.deepEqual(
    keys(completed),
    [
      ...sharedKeys,
      "durationMs",
      "outcome",
      ...(outbox ? ["outboxMessageCount"] : []),
      ...(transaction ? ["transactionDurationMs"] : []),
      ...(transition ? ["transitionId"] : []),
    ].sort(),
  );
  assert.equal(Number.isFinite(completed.durationMs), true);
  assert.ok(completed.durationMs >= 0);
  if (transaction) {
    assert.equal(Number.isFinite(completed.transactionDurationMs), true);
    assert.ok(completed.transactionDurationMs >= 0);
  }
  assertSafe(started);
  assertSafe(completed);
}

async function observedTransition(options = {}, request = transitionRequest) {
  const observations = [];
  const fixture = executorFixture({
    ...options,
    observer: { observe: (observation) => observations.push(observation) },
  });
  return {
    observations,
    result: await fixture.subject.transition(request),
    fixture,
  };
}

test("observer reports every expected assessment and transition outcome", async () => {
  {
    const observations = [];
    const fixture = executorFixture({
      observer: { observe: (value) => observations.push(value) },
    });
    const result = await fixture.subject.assess({
      id: "item-1",
      event: "move",
    });
    assert.equal(result.status, "allowed");
    assertPair(observations, {
      mode: "assess",
      outcome: "allowed",
      transaction: true,
    });
  }

  const cases = [
    {
      name: "committed",
      options: { outbox: () => [{ topic: "item.moved", payload: {} }] },
      outcome: "committed",
      transaction: true,
      transition: true,
      outbox: true,
    },
    {
      name: "duplicate",
      options: { claim: { status: "duplicate", transition: validDuplicate } },
      outcome: "duplicate",
      transaction: true,
      transition: true,
    },
    {
      name: "authorization denial",
      options: { authorize: () => false },
      outcome: "denied",
      transaction: true,
    },
    {
      name: "guard denial",
      options: {
        guards: [{ name: "blocked", evaluate: () => false }],
      },
      outcome: "denied",
      transaction: true,
    },
    {
      name: "invalid input",
      options: {
        input: {
          parse: () => ({
            success: false,
            issues: [{ path: [], code: "INVALID", message: "invalid" }],
          }),
        },
      },
      request: { ...transitionRequest, input: {} },
      outcome: "invalid-input",
    },
    {
      name: "unknown event",
      request: { ...transitionRequest, event: "missing" },
      outcome: "unknown-event",
    },
    {
      name: "not found",
      options: { loadPrimary: async () => null },
      outcome: "not-found",
      transaction: true,
    },
    {
      name: "stale version",
      request: { ...transitionRequest, expectedVersion: "2" },
      outcome: "conflict",
      transaction: true,
    },
    {
      name: "idempotency conflict",
      options: { claim: { status: "conflict" } },
      outcome: "idempotency-conflict",
      transaction: true,
    },
  ];
  for (const scenario of cases) {
    const { result, observations } = await observedTransition(
      scenario.options,
      scenario.request,
    );
    assert.notEqual(result.status, undefined, scenario.name);
    assertPair(observations, {
      mode: "transition",
      outcome: scenario.outcome,
      transaction: scenario.transaction,
      transition: scenario.transition,
      outbox: scenario.outbox,
    });
    if (scenario.outbox) assert.equal(observations[1].outboxMessageCount, 1);
  }
});

test("observer allowlist includes only explicit correlation metadata", async () => {
  const { observations } = await observedTransition(
    {},
    {
      ...transitionRequest,
      actor: { secret: "actor-secret" },
      input: { secret: "input-secret" },
      metadata: { secret: "metadata-secret" },
      correlationId: "correlation-1",
      causationId: "causation-1",
    },
  );
  for (const observation of observations) {
    assert.equal(observation.correlationId, "correlation-1");
    assert.equal(observation.causationId, "causation-1");
    assertSafe(observation);
  }
  assert.deepEqual(
    keys(observations[0]),
    [...sharedKeys, "causationId", "correlationId"].sort(),
  );
});

function transactionDriver(transaction) {
  return {
    transaction,
    claimIdempotency: async () => ({ status: "claimed" }),
    completeIdempotency: async () => {},
    insertTransition: async () => {},
    insertOutbox: async () => {},
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected rejection.");
}

test("observer reports the stable failure phase for every protocol boundary", async () => {
  const stages = [
    {
      phase: "request",
      options: (failure) => ({
        input: {
          parse: () => {
            throw failure;
          },
        },
      }),
      request: { ...transitionRequest, input: {} },
      commitOutcome: "not-started",
      transactionDuration: false,
    },
    {
      phase: "transaction",
      options: (failure) => ({
        driver: transactionDriver(async () => {
          throw failure;
        }),
      }),
      commitOutcome: "not-started",
      transactionDuration: false,
    },
    {
      phase: "idempotency",
      options: (failure) => ({
        claimCallback: () => {
          throw failure;
        },
      }),
    },
    {
      phase: "load-primary",
      options: (failure) => ({
        loadPrimary: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "context",
      options: (failure) => ({
        context: () => {
          throw failure;
        },
      }),
    },
    {
      phase: "assessment",
      options: (failure) => ({
        authorize: () => {
          throw failure;
        },
      }),
    },
    {
      phase: "planning",
      options: (failure) => ({
        mutate: () => {
          throw failure;
        },
      }),
    },
    {
      phase: "primary-write",
      options: (failure) => ({
        applyPrimary: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "history",
      options: (failure) => ({
        insertTransition: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "related-writes",
      options: (failure) => ({
        applyRelated: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "outbox",
      options: (failure) => ({
        outbox: () => [{ topic: "probe", payload: {} }],
        insertOutbox: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "idempotency-completion",
      options: (failure) => ({
        complete: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "hydration",
      options: (failure) => ({
        hydrate: async () => {
          throw failure;
        },
      }),
    },
    {
      phase: "commit",
      options: (failure) => ({
        driver: transactionDriver(async (operation) => {
          await operation({});
          throw failure;
        }),
      }),
    },
  ];
  for (const stage of stages) {
    const failure = new InterlockError("INTERLOCK_CANCELLED", stage.phase);
    const observations = [];
    const fixture = executorFixture({
      ...stage.options(failure),
      observer: { observe: (value) => observations.push(value) },
    });
    const thrown = await rejection(
      fixture.subject.transition(stage.request ?? transitionRequest),
    );
    assert.equal(thrown, failure, stage.phase);
    assert.equal(observations.length, 2, stage.phase);
    const terminal = observations[1];
    assert.equal(terminal.type, "interlock.operation.failed", stage.phase);
    assert.equal(terminal.code, "INTERLOCK_CANCELLED", stage.phase);
    assert.equal(terminal.phase, stage.phase, stage.phase);
    assert.equal(
      terminal.commitOutcome,
      stage.commitOutcome ?? "not-committed",
      stage.phase,
    );
    assert.deepEqual(
      keys(terminal),
      [
        ...sharedKeys,
        "code",
        "commitOutcome",
        "durationMs",
        "phase",
        ...(stage.transactionDuration === false
          ? []
          : ["transactionDurationMs"]),
      ].sort(),
      stage.phase,
    );
    assertSafe(terminal);
  }
});

test("observer reports final result validation after transactional writes", async () => {
  let applied;
  const observations = [];
  const fixture = executorFixture({
    applyPrimary: async (args) => {
      applied = {
        ...args.resource,
        state: args.toState,
        version: args.nextVersion,
      };
      return { status: "applied", resource: applied };
    },
    insertTransition: async () => {
      applied.state = "corrupted";
    },
    observer: { observe: (value) => observations.push(value) },
  });
  const error = await rejection(fixture.subject.transition(transitionRequest));
  assert.equal(isInterlockError(error), true);
  assert.equal(observations[1].phase, "result");
  assert.equal(observations[1].code, "INTERLOCK_BINDING_PROTOCOL_VIOLATION");
});

test("hydrated resource postconditions fail in the result phase", async () => {
  for (const resource of [
    { id: "wrong", state: "b", version: "2" },
    { id: "item-1", state: "a", version: "2" },
    { id: "item-1", state: "b", version: "1" },
  ]) {
    const observations = [];
    const fixture = executorFixture({
      hydrate: async () => resource,
      observer: { observe: (value) => observations.push(value) },
    });
    const error = await rejection(
      fixture.subject.transition(transitionRequest),
    );
    assert.equal(isInterlockError(error), true);
    assert.deepEqual(
      {
        code: observations[1].code,
        phase: observations[1].phase,
        commitOutcome: observations[1].commitOutcome,
      },
      {
        code: "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        phase: "result",
        commitOutcome: "not-committed",
      },
    );
  }
});

test("unknown commit is a failed commit with an unknown outcome", async () => {
  const failure = new InterlockError(
    "INTERLOCK_COMMIT_OUTCOME_UNKNOWN",
    "unknown commit",
  );
  const observations = [];
  const fixture = executorFixture({
    driver: transactionDriver(async (operation) => {
      await operation({});
      throw failure;
    }),
    observer: { observe: (value) => observations.push(value) },
  });
  const thrown = await rejection(fixture.subject.transition(transitionRequest));
  assert.equal(thrown, failure);
  assert.equal(observations.length, 2);
  assert.deepEqual(
    {
      type: observations[1].type,
      phase: observations[1].phase,
      commitOutcome: observations[1].commitOutcome,
    },
    {
      type: "interlock.operation.failed",
      phase: "commit",
      commitOutcome: "unknown",
    },
  );
  assert.equal(Number.isFinite(observations[1].transactionDurationMs), true);
});

test("observer callbacks always run outside the transaction", async () => {
  let active = false;
  const observations = [];
  const driver = transactionDriver(async (operation) => {
    assert.equal(active, false);
    active = true;
    try {
      return await operation({ privateTransaction: true });
    } finally {
      active = false;
    }
  });
  const fixture = executorFixture({
    driver,
    observer: {
      observe(observation) {
        assert.equal(active, false);
        assert.equal("transaction" in observation, false);
        observations.push(observation);
      },
    },
  });
  await fixture.subject.transition(transitionRequest);
  assert.equal(observations.length, 2);

  const failure = new InterlockError("INTERLOCK_CANCELLED", "cancelled");
  const failed = [];
  const failedFixture = executorFixture({
    driver: transactionDriver(async (operation) => {
      active = true;
      try {
        await operation({});
        throw failure;
      } finally {
        active = false;
      }
    }),
    observer: {
      observe(observation) {
        assert.equal(active, false);
        failed.push(observation);
      },
    },
  });
  assert.equal(
    await rejection(failedFixture.subject.transition(transitionRequest)),
    failure,
  );
  assert.equal(failed.length, 2);
});

test("observer exceptions never change results or suppress terminals", async () => {
  for (const throwingType of [
    "interlock.operation.started",
    "interlock.operation.completed",
  ]) {
    const seen = [];
    const fixture = executorFixture({
      observer: {
        observe(observation) {
          seen.push(observation.type);
          if (observation.type === throwingType) throw new Error("observer");
        },
      },
    });
    const result = await fixture.subject.transition(transitionRequest);
    assert.equal(result.status, "committed");
    assert.deepEqual(seen, [
      "interlock.operation.started",
      "interlock.operation.completed",
    ]);
  }

  const failure = new InterlockError("INTERLOCK_CANCELLED", "cancelled");
  const seen = [];
  const fixture = executorFixture({
    driver: transactionDriver(async () => {
      throw failure;
    }),
    observer: {
      observe(observation) {
        seen.push(observation.type);
        if (observation.type === "interlock.operation.failed")
          throw new Error("observer");
      },
    },
  });
  assert.equal(
    await rejection(fixture.subject.transition(transitionRequest)),
    failure,
  );
  assert.deepEqual(seen, [
    "interlock.operation.started",
    "interlock.operation.failed",
  ]);
});

test("mutable timing globals cannot affect observed operations", async () => {
  const originalNow = performance.now;
  try {
    const successful = [];
    const successFixture = executorFixture({
      observer: {
        observe(observation) {
          successful.push(observation);
          if (observation.type === "interlock.operation.started")
            performance.now = () => {
              throw new Error("mutated clock");
            };
        },
      },
    });
    const result = await successFixture.subject.transition(transitionRequest);
    assert.equal(result.status, "committed");
    assert.deepEqual(
      successful.map((observation) => observation.type),
      ["interlock.operation.started", "interlock.operation.completed"],
    );

    const failure = new InterlockError("INTERLOCK_CANCELLED", "cancelled");
    const failed = [];
    const failureFixture = executorFixture({
      driver: transactionDriver(async () => {
        throw failure;
      }),
      observer: {
        observe(observation) {
          failed.push(observation);
          if (observation.type === "interlock.operation.started")
            performance.now = () => {
              throw new Error("mutated clock");
            };
        },
      },
    });
    assert.equal(
      await rejection(failureFixture.subject.transition(transitionRequest)),
      failure,
    );
    assert.deepEqual(
      failed.map((observation) => observation.type),
      ["interlock.operation.started", "interlock.operation.failed"],
    );
  } finally {
    performance.now = originalNow;
  }
});

test("observer promise and thenable failures are consumed without waiting", async () => {
  let unhandled;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const returned = [
      Promise.reject(new Error("native rejection")),
      {
        then(_resolve, reject) {
          reject(new Error("thenable rejection"));
        },
      },
      Object.defineProperty({}, "then", {
        get() {
          throw new Error("then getter");
        },
      }),
    ];
    for (const value of returned) {
      const fixture = executorFixture({ observer: { observe: () => value } });
      const result = await fixture.subject.transition(transitionRequest);
      assert.equal(result.status, "committed");
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("observer configuration is captured once with its receiver", async () => {
  let optionReads = 0;
  let observeReads = 0;
  let replacementCalls = 0;
  const receiver = {
    calls: 0,
    get observe() {
      observeReads += 1;
      if (observeReads > 1)
        return () => {
          replacementCalls += 1;
        };
      return function () {
        this.calls += 1;
      };
    },
  };
  const fixture = executorFixture({
    observer: receiver,
    clientOptions: (base) =>
      new Proxy(base, {
        get(target, key, proxyReceiver) {
          if (key === "observer") optionReads += 1;
          return Reflect.get(target, key, proxyReceiver);
        },
      }),
  });
  await fixture.subject.transition(transitionRequest);
  assert.equal(optionReads, 1);
  assert.equal(observeReads, 1);
  assert.equal(receiver.calls, 2);
  assert.equal(replacementCalls, 0);

  class PrivateObserver {
    #count = 0;
    observe() {
      this.#count += 1;
    }
    count() {
      return this.#count;
    }
  }
  const classObserver = new PrivateObserver();
  const classFixture = executorFixture({ observer: classObserver });
  await classFixture.subject.transition(transitionRequest);
  assert.equal(classObserver.count(), 2);
});

test("malformed observers fail during client construction", () => {
  for (const observer of [null, {}, { observe: true }])
    assert.throws(
      () => executorFixture({ observer }),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_INVALID",
    );
});

test("no observer leaves ordinary execution unchanged", async () => {
  const fixture = executorFixture();
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.equal(result.duplicate, false);
});
