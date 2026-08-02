import test from "node:test";
import assert from "node:assert/strict";
import {
  executorFixture,
  transitionRequest,
  validDuplicate,
} from "./fixture.mjs";

function changing(first, later) {
  let reads = 0;
  return {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? first : later;
    },
  };
}

test("request protocol fields are read once from a Proxy", async () => {
  const values = {
    id: "item-1",
    event: "move",
    actor: undefined,
    expectedVersion: "1",
    correlationId: "correlation-1",
    causationId: "causation-1",
    idempotency: Object.defineProperties(
      {},
      {
        key: changing("key", 123),
      },
    ),
  };
  const reads = new Map();
  const request = new Proxy(values, {
    get(target, property, receiver) {
      const count = (reads.get(property) ?? 0) + 1;
      reads.set(property, count);
      if (
        count > 1 &&
        ["id", "event", "correlationId", "causationId"].includes(property)
      )
        return 123;
      return Reflect.get(target, property, receiver);
    },
  });
  const fixture = executorFixture();
  const result = await fixture.subject.transition(request);
  assert.equal(result.status, "committed");
  assert.equal(fixture.getClaim().resourceId, "item-1");
  assert.equal(fixture.getClaim().key, "key");
  assert.equal(fixture.getTransition().event, "move");
  assert.equal(fixture.getTransition().correlationId, "correlation-1");
  assert.equal(fixture.getTransition().causationId, "causation-1");
  for (const field of [
    "id",
    "event",
    "correlationId",
    "causationId",
    "idempotency",
  ])
    assert.equal(reads.get(field), 1, field);
});

test("transaction and consistency declarations use one validated read", async () => {
  const transactionOptions = Object.defineProperties(
    {},
    {
      isolation: changing("read-committed", 123),
      readOnly: changing(false, "invalid"),
    },
  );
  let observed;
  const fixture = executorFixture({
    transactionOptions,
    observeTransactionOptions: (value) => {
      observed = value;
    },
    consistency: () =>
      Object.defineProperties(
        {},
        {
          strategy: changing("custom", 123),
          notes: changing("stable", 123),
        },
      ),
  });
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.deepEqual(observed, { isolation: "read-committed", readOnly: false });
  assert.deepEqual(fixture.subject.consistency("move"), {
    strategy: "custom",
    notes: "stable",
  });
});

test("authorization and denial fields are snapshotted once", async () => {
  const denial = Object.defineProperties(
    {},
    {
      code: changing("BLOCKED", 123),
      message: changing("Not allowed", 123),
      publicDetails: changing({ safe: true }, new Date()),
      privateMessage: changing("private", 123),
      privateDetails: changing({ internal: true }, new Date()),
    },
  );
  const decision = Object.defineProperties(
    {},
    {
      allowed: changing(false, true),
      denial: changing(denial, null),
    },
  );
  const result = await executorFixture({
    authorize: () => decision,
  }).subject.assess({
    id: "item-1",
    event: "move",
  });
  assert.deepEqual(result, {
    status: "denied",
    event: "move",
    currentState: "a",
    targetState: "b",
    reason: {
      source: "authorization",
      code: "BLOCKED",
      message: "Not allowed",
      publicDetails: { safe: true },
    },
  });
});

test("outbox and actor descriptors are detached from getter changes", async () => {
  const descriptor = Object.defineProperties(
    {},
    {
      topic: changing("item.moved", 123),
      key: changing("item-1", 123),
      payload: changing({ value: 1 }, new Date()),
    },
  );
  const identity = Object.defineProperties(
    {},
    {
      actorType: changing("user", 123),
      actorId: changing("user-1", 123),
    },
  );
  const fixture = executorFixture({
    outbox: () => [descriptor],
    actorCallback: () => identity,
  });
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.deepEqual(fixture.getOutbox()[0], {
    id: "transition-1",
    lifecycle: "item",
    resourceType: "item",
    resourceId: "item-1",
    transitionId: "transition-1",
    topic: "item.moved",
    key: "item-1",
    payload: { value: 1 },
    createdAt: new Date("2026-01-01T00:00:01.000Z"),
  });
  assert.equal(fixture.getTransition().actorType, "user");
  assert.equal(fixture.getTransition().actorId, "user-1");
});

test("primary result status and conflict snapshots are read once", async () => {
  const applied = Object.defineProperties(
    {},
    {
      status: changing("applied", "conflict"),
      resource: changing(
        { id: "item-1", state: "b", version: "2" },
        { id: "other", state: "a", version: "1" },
      ),
    },
  );
  const committed = await executorFixture({
    applyPrimary: () => applied,
  }).subject.transition(transitionRequest);
  assert.equal(committed.status, "committed");
  assert.equal(committed.resource.id, "item-1");

  const actual = Object.defineProperties(
    {},
    {
      state: changing("a", 123),
      version: changing("2", "invalid"),
    },
  );
  const conflict = Object.defineProperties(
    {},
    {
      status: changing("conflict", "applied"),
      actual: changing(actual, null),
    },
  );
  assert.deepEqual(
    await executorFixture({ applyPrimary: () => conflict }).subject.transition(
      transitionRequest,
    ),
    {
      status: "conflict",
      expected: "1",
      actual: { state: "a", version: "2" },
    },
  );
});

test("hydration identity accessors are evaluated once for the returned resource", async () => {
  const hydrated = { id: "item-1", state: "b", version: "2" };
  const reads = { id: 0, state: 0, version: 0 };
  const fixture = executorFixture({
    hydrate: async () => hydrated,
    bindingAccessors: {
      getId(resource) {
        if (resource !== hydrated) return resource.id;
        reads.id += 1;
        return reads.id === 1 ? "item-1" : "other";
      },
      getState(resource) {
        if (resource !== hydrated) return resource.state;
        reads.state += 1;
        return reads.state === 1 ? "b" : "a";
      },
      getVersion(resource) {
        if (resource !== hydrated) return resource.version;
        reads.version += 1;
        return reads.version === 1 ? "2" : "1";
      },
    },
  });
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.equal(result.resource, hydrated);
  assert.deepEqual(reads, { id: 1, state: 1, version: 1 });
});

test("history is inserted before related writes and outbox", async () => {
  const fixture = executorFixture({
    applyRelated: async () => fixture.order.push("related"),
    outbox: () => [{ topic: "item.moved", payload: {} }],
  });
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.ok(fixture.order.indexOf("apply") < fixture.order.indexOf("history"));
  assert.ok(
    fixture.order.indexOf("history") < fixture.order.indexOf("related"),
  );
  assert.ok(fixture.order.indexOf("related") < fixture.order.indexOf("outbox"));
  assert.ok(
    fixture.order.indexOf("outbox") < fixture.order.indexOf("complete"),
  );
});

test("duplicate transition protocol fields are read once", async () => {
  const transition = Object.defineProperties(
    {},
    {
      id: changing(validDuplicate.id, "other"),
      lifecycle: changing(validDuplicate.lifecycle, "other"),
      resourceType: changing(validDuplicate.resourceType, "other"),
      resourceId: changing(validDuplicate.resourceId, "other"),
      event: changing(validDuplicate.event, "other"),
      fromState: changing(validDuplicate.fromState, "other"),
      toState: changing(validDuplicate.toState, "other"),
      previousVersion: changing(validDuplicate.previousVersion, "invalid"),
      nextVersion: changing(validDuplicate.nextVersion, "invalid"),
      idempotencyKey: changing(validDuplicate.idempotencyKey, "other"),
      requestFingerprint: changing(validDuplicate.requestFingerprint, "other"),
      occurredAt: changing(validDuplicate.occurredAt, new Date("invalid")),
    },
  );
  const result = await executorFixture({
    claim: { status: "duplicate", transition },
  }).subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.transition, validDuplicate);
});
