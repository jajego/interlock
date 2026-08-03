import test from "node:test";
import assert from "node:assert/strict";
import {
  assertJsonValue,
  canonicalHash,
  canonicalJson,
  createInterlock,
  defineLifecycle,
  isInterlockError,
  incrementVersion,
  MAX_BIGINT_VERSION,
  noInput,
  parseVersionToken,
} from "../packages/core/dist/index.js";
import {
  normalizePostgresError,
  PostgresDriver,
} from "../packages/postgres/dist/index.js";
import {
  executorFixture,
  transitionRequest,
  validDuplicate,
} from "./core/fixture.mjs";
import "./core/protocol-boundaries.test.mjs";
import "./core/lifecycle-boundaries.test.mjs";
import "./core/observer.test.mjs";

test("version tokens reject unsafe counters and increment PostgreSQL BIGINT values", () => {
  assert.equal(parseVersionToken("0").success, false);
  const parsed = parseVersionToken("9007199254740993");
  assert.equal(parsed.success, true);
  if (parsed.success)
    assert.equal(incrementVersion(parsed.value), "9007199254740994");
  assert.equal(
    parseVersionToken(String(MAX_BIGINT_VERSION + 1n)).success,
    false,
  );
  assert.throws(
    () => incrementVersion(String(MAX_BIGINT_VERSION)),
    (error) =>
      isInterlockError(error) && error.code === "INTERLOCK_VERSION_EXHAUSTED",
  );
});

test("canonical JSON ignores object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
});

test("JSON validation rejects cycles deterministically", () => {
  const value = {};
  value.self = value;
  assert.throws(() => assertJsonValue(value), /cyclic/);
  const array = [];
  array.push(array);
  assert.throws(() => assertJsonValue(array), /cyclic/);
});

test("JSON validation rejects every non-JSON runtime category", () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    { value: undefined },
    Object.create(null),
  ])
    assert.throws(() => assertJsonValue(value), TypeError);
});

test("definitions reject accidental self transitions", () => {
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["open"],
      history: { resourceType: "item" },
      events: {
        close: { from: ["open"], to: "open", mutate: () => ({}) },
      },
    }),
  );
});

test("definitions reject duplicate states and guard names", () => {
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["a", "a"],
      history: { resourceType: "item" },
      events: {},
    }),
  );
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["a", "b"],
      history: { resourceType: "item" },
      events: {
        move: {
          from: ["a"],
          to: "b",
          guards: [
            { name: "same", evaluate: () => ({ allowed: true }) },
            { name: "same", evaluate: () => ({ allowed: true }) },
          ],
          mutate: () => ({}),
        },
      },
    }),
  );
});

test("camel-case events are valid and definition errors identify the field", () => {
  const lifecycle = defineLifecycle()({
    name: "item",
    states: ["open", "under_review"],
    history: { resourceType: "item" },
    events: {
      submitForReview: { from: ["open"], to: "under_review" },
    },
  });
  assert.equal(lifecycle.getEvent("submitForReview").to, "under_review");

  for (const [event, message] of [
    [{ from: [], to: "under_review" }, "at least one source state"],
    [{ from: ["missing"], to: "under_review" }, "unknown source state"],
    [{ from: ["open"], to: "missing" }, "unknown target state"],
    [{ from: ["open", "open"], to: "under_review" }, "duplicate source"],
  ])
    assert.throws(
      () =>
        defineLifecycle()({
          name: "item",
          states: ["open", "under_review"],
          history: { resourceType: "item" },
          events: { move: event },
        }),
      (error) => isInterlockError(error) && error.message.includes(message),
    );
});

test("prototype property names never resolve as lifecycle events", async () => {
  const lifecycle = defineLifecycle()({
    name: "item",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: { move: { from: ["a"], to: "b" } },
  });
  const names = ["toString", "constructor", "__proto__", "hasOwnProperty"];
  for (const name of names)
    assert.equal(lifecycle.getEvent(name), undefined, name);
  const fixture = executorFixture();
  for (const name of names)
    assert.deepEqual(
      await fixture.subject.assess({ id: "item-1", event: name }),
      { status: "unknown-event", event: name },
    );
});

test("validated definitions are stable after caller mutation", () => {
  const definition = {
    name: "item",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: { move: { from: ["a"], to: "b", mutate: () => ({}) } },
  };
  const lifecycle = defineLifecycle()(definition);
  definition.events.move.to = "invalid";
  definition.events.other = definition.events.move;
  assert.equal(lifecycle.getEvent("move").to, "b");
  assert.equal(lifecycle.getEvent("other"), undefined);
  assert.ok(Object.isFrozen(lifecycle.getEvent("move").from));
});

test("validated definitions snapshot caller-owned input parsers", async () => {
  const schema = {
    parse: () => ({ success: true, value: "original" }),
  };
  const lifecycle = defineLifecycle()({
    name: "parser",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: {
      move: {
        from: ["a"],
        to: "b",
        input: schema,
        mutate: () => ({}),
      },
    },
  });
  schema.parse = () => ({ success: true, value: "mutated" });
  const parsed = await lifecycle.parseInput(lifecycle.getEvent("move"), {});
  assert.deepEqual(parsed, { success: true, value: "original" });
});

test("no-input and Standard Schema adapters normalize runtime results", async () => {
  assert.deepEqual(await noInput.parse(undefined), {
    success: true,
    value: undefined,
  });
  assert.equal((await noInput.parse("unexpected")).success, false);

  for (const validate of [
    () => ({ value: "parsed" }),
    async () => ({ value: "parsed" }),
  ]) {
    const lifecycle = defineLifecycle()({
      name: "schema",
      states: ["a", "b"],
      history: { resourceType: "item" },
      events: {
        move: {
          from: ["a"],
          to: "b",
          input: { "~standard": { version: 1, validate } },
          mutate: () => ({}),
        },
      },
    });
    assert.deepEqual(
      await lifecycle.parseInput(lifecycle.getEvent("move"), {}),
      { success: true, value: "parsed" },
    );
  }

  const standardFailure = defineLifecycle()({
    name: "schema",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: {
      move: {
        from: ["a"],
        to: "b",
        input: {
          "~standard": {
            version: 1,
            validate: () => ({
              issues: [{ message: "bad", path: [{ key: "field" }, 2] }],
            }),
          },
        },
        mutate: () => ({}),
      },
    },
  });
  assert.deepEqual(
    await standardFailure.parseInput(standardFailure.getEvent("move"), {}),
    {
      success: false,
      issues: [{ path: ["field", 2], code: "INVALID_INPUT", message: "bad" }],
    },
  );

  const customFailure = defineLifecycle()({
    name: "schema",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: {
      move: {
        from: ["a"],
        to: "b",
        input: {
          parse: () => ({
            success: false,
            issues: [{ path: ["field"], code: "BAD", message: "bad" }],
          }),
        },
        mutate: () => ({}),
      },
    },
  });
  assert.deepEqual(
    await customFailure.parseInput(customFailure.getEvent("move"), {}),
    {
      success: false,
      issues: [{ path: ["field"], code: "BAD", message: "bad" }],
    },
  );
});

test("schema adapters reject malformed success, failure, and issue results", async () => {
  for (const input of [
    { parse: () => ({}) },
    { parse: () => ({ success: true }) },
    { parse: () => ({ success: false }) },
    {
      parse: () => ({
        success: false,
        issues: [{ path: [null], code: "bad", message: "bad" }],
      }),
    },
    { "~standard": { version: 1, validate: () => ({}) } },
    {
      "~standard": {
        version: 1,
        validate: () => ({ issues: [{ message: 1 }] }),
      },
    },
    {
      "~standard": {
        version: 1,
        validate: () => ({ issues: [{ message: "bad", path: "field" }] }),
      },
    },
  ]) {
    const lifecycle = defineLifecycle()({
      name: "schema",
      states: ["a", "b"],
      history: { resourceType: "item" },
      events: {
        move: { from: ["a"], to: "b", input, mutate: () => ({}) },
      },
    });
    await assert.rejects(
      lifecycle.parseInput(lifecycle.getEvent("move"), {}),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
    );
  }
});

test("lifecycle definitions reject malformed public fields", () => {
  const valid = () => ({
    name: "item",
    states: ["a", "b"],
    history: { resourceType: "item" },
    events: { move: { from: ["a"], to: "b", mutate: () => ({}) } },
  });
  const cases = [
    { ...valid(), name: "Bad Name" },
    { ...valid(), states: [] },
    { ...valid(), history: { resourceType: "" } },
    { ...valid(), definitionVersion: "" },
    { ...valid(), idempotency: { fingerprint: true } },
    { ...valid(), events: null },
    { ...valid(), events: { "": valid().events.move } },
    { ...valid(), events: { move: { ...valid().events.move, from: [] } } },
    { ...valid(), events: { move: { ...valid().events.move, to: "missing" } } },
    {
      ...valid(),
      events: { move: { ...valid().events.move, guards: [null] } },
    },
    {
      ...valid(),
      events: { move: { ...valid().events.move, authorize: true } },
    },
    {
      ...valid(),
      events: { move: { ...valid().events.move, input: {} } },
    },
    ...[null, false, 0, ""].map((input) => ({
      ...valid(),
      events: { move: { ...valid().events.move, input } },
    })),
    {
      ...valid(),
      events: { move: { ...valid().events.move, input: { parse: true } } },
    },
  ];
  for (const definition of cases)
    assert.throws(
      () => defineLifecycle()(definition),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_INVALID",
    );
});

test("operation context reaches loading, context, and writes immutably", async () => {
  const seen = [];
  const actor = { id: "user-1", tenantId: "tenant-1" };
  const fixture = executorFixture({
    loadPrimary: async (_transaction, operation) => {
      seen.push(["load", operation]);
      assert.equal(operation.actor.tenantId, "tenant-1");
      assert.equal(operation.metadata.source, "api");
      assert.equal(Object.isFrozen(operation), true);
      assert.equal(Object.isFrozen(operation.metadata), true);
      return { id: operation.id, state: "a", version: "1" };
    },
    context: (_transaction, operation) => {
      seen.push(["context", operation]);
      return { tenantId: operation.actor.tenantId };
    },
    mutate: ({ operation }) => {
      assert.equal(operation.correlationId, "correlation-1");
      assert.equal(operation.metadata.source, "api");
      assert.equal(Object.isFrozen(operation), true);
      return {};
    },
    observeApply: (args) => {
      seen.push(["primary", args.operation]);
      assert.equal(args.operation.event, "move");
      assert.equal(Object.isFrozen(args.operation), true);
    },
    applyRelated: async (_transaction, args) => {
      seen.push(["related", args.operation]);
      assert.equal(args.operation.event, "move");
    },
  });
  const result = await fixture.subject.transition({
    ...transitionRequest,
    actor,
    metadata: { source: "api" },
    correlationId: "correlation-1",
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(
    seen.map(([boundary]) => boundary),
    ["load", "context", "primary", "related"],
  );
  assert.equal(seen[0][1], seen[1][1]);
  assert.equal(seen[2][1], seen[3][1]);
});

test("callback envelopes are frozen without deep-freezing application values", async () => {
  const resource = { id: "item-1", state: "a", version: "1" };
  const input = { value: "original" };
  let authorizationArgs;
  let projectionArgs;
  const fixture = executorFixture({
    input: { parse: () => ({ success: true, value: input }) },
    loadPrimary: async () => resource,
    authorize: (args) => {
      authorizationArgs = args;
      assert.equal(Object.isFrozen(args), true);
      assert.equal(Object.isFrozen(args.resource), false);
      assert.throws(() => {
        args.resource = { id: "malicious", state: "a", version: "1" };
      }, TypeError);
      return true;
    },
    guards: [
      {
        name: "original-values",
        evaluate: (args) => {
          assert.equal(args, authorizationArgs);
          assert.equal(args.resource, resource);
          assert.equal(args.input, input);
          return true;
        },
      },
    ],
    mutate: (args) => {
      projectionArgs = args;
      assert.equal(Object.isFrozen(args), true);
      assert.throws(() => {
        args.transitionId = "malicious";
      }, TypeError);
      return {};
    },
    audit: (args) => {
      assert.equal(args, projectionArgs);
      assert.equal(args.resource, resource);
      assert.equal(args.transitionId, "transition-1");
      return {};
    },
  });
  const result = await fixture.subject.transition({
    ...transitionRequest,
    input: {},
  });
  assert.equal(result.status, "committed");
});

test("ordinary transitions default options, context, and mutation", async () => {
  let options;
  const fixture = executorFixture({
    noMutation: true,
    omitContext: true,
    omitTransactionOptions: true,
    observeTransactionOptions: (value) => {
      options = value;
    },
    observeApply: (args) => assert.equal(args.operation.mutation, undefined),
  });
  const result = await fixture.subject.transition({
    id: "item-1",
    event: "move",
    expectedVersion: "1",
    idempotency: { key: "key" },
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(options, {});
});

test("async projections settle in order before the first write", async () => {
  const order = [];
  const fixture = executorFixture({
    mutate: async () => {
      order.push("mutate");
      return { value: 1 };
    },
    audit: async () => {
      order.push("audit");
      return { value: 2 };
    },
    outbox: async () => {
      order.push("outbox");
      return [{ topic: "planned", payload: { value: 3 } }];
    },
    actorCallback: async () => {
      order.push("actor");
      return { actorId: "user-1" };
    },
    metadataCallback: async () => {
      order.push("metadata");
      return { value: 4 };
    },
    observeApply: () => order.push("apply"),
  });
  await fixture.subject.transition(transitionRequest);
  assert.deepEqual(order, [
    "mutate",
    "audit",
    "outbox",
    "actor",
    "metadata",
    "apply",
  ]);
});

test("async projection rejection prevents every write", async () => {
  const cause = new Error("projection failed");
  const fixture = executorFixture({ audit: async () => Promise.reject(cause) });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION" &&
      error.cause === cause,
  );
  assert.equal(fixture.order.includes("apply"), false);
  assert.equal(fixture.order.includes("history"), false);
});

test("transition clock is allocated after authoritative assessment", async () => {
  const fixture = executorFixture();
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.deepEqual(fixture.order.slice(0, 5), [
    "clock",
    "claim",
    "authorize",
    "clock",
    "mutate",
  ]);
  assert.equal(
    fixture.getTransition().occurredAt.toISOString(),
    "2026-01-01T00:00:01.000Z",
  );
});

test("clock providers must return finite Dates", async () => {
  for (const value of [new Date("invalid"), "not-a-date"]) {
    const fixture = executorFixture({ now: () => value });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
    );
    assert.equal(fixture.order.includes("claim"), false);
    assert.equal(fixture.order.includes("apply"), false);
  }
});

test("clock provider objects are copied at each boundary", async () => {
  const shared = new Date("2026-01-01T00:00:00.000Z");
  const fixture = executorFixture({ now: () => shared });
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.notEqual(fixture.getClaim().createdAt, shared);
  assert.notEqual(fixture.getTransition().occurredAt, shared);
  assert.notEqual(
    fixture.getClaim().createdAt,
    fixture.getTransition().occurredAt,
  );
});

test("clock mutation in projections fails before application writes", async () => {
  const mutations = {
    mutate: {
      mutate: ({ clock }) => {
        clock.occurredAt.setUTCFullYear(2030);
        return {};
      },
    },
    audit: {
      audit: ({ clock }) => {
        clock.occurredAt.setUTCFullYear(2030);
        return {};
      },
    },
    outbox: {
      outbox: ({ clock }) => {
        clock.occurredAt.setUTCFullYear(2030);
        return [];
      },
    },
    metadata: (() => {
      let occurredAt;
      return {
        mutate: ({ clock }) => {
          occurredAt = clock.occurredAt;
          return {};
        },
        metadataCallback: () => {
          occurredAt.setUTCFullYear(2030);
          return {};
        },
      };
    })(),
  };
  for (const [projection, options] of Object.entries(mutations)) {
    const fixture = executorFixture(options);
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      projection,
    );
    assert.equal(fixture.order.includes("apply"), false, projection);
    assert.equal(fixture.order.includes("history"), false, projection);
  }
});

test("history projections and serialization finish before application writes", async () => {
  const fixture = executorFixture();
  await fixture.subject.transition(transitionRequest);
  assert.ok(fixture.order.indexOf("metadata") < fixture.order.indexOf("apply"));
});

test("planned JSON and actor identity are snapshotted before writes", async () => {
  const auditData = { value: "planned" };
  const metadata = { value: "planned" };
  const message = {
    topic: "planned",
    key: "planned",
    payload: { value: "planned" },
  };
  const actorIdentity = { actorType: "user", actorId: "planned" };
  const fixture = executorFixture({
    audit: () => auditData,
    metadataCallback: async () => {
      await Promise.resolve();
      return { ...metadata };
    },
    actorCallback: () => {
      globalThis.queueMicrotask(() => {
        actorIdentity.actorId = "mutated";
      });
      return actorIdentity;
    },
    outbox: () => {
      globalThis.queueMicrotask(() => {
        auditData.value = "mutated";
        message.topic = "mutated";
        message.key = "mutated";
        message.payload.value = "mutated";
      });
      return [message];
    },
  });

  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.equal(fixture.getTransition().auditData.value, "planned");
  assert.equal(fixture.getTransition().metadata.value, "planned");
  assert.equal(fixture.getTransition().actorId, "planned");
  assert.equal(fixture.getOutbox()[0].topic, "planned");
  assert.equal(fixture.getOutbox()[0].key, "planned");
  assert.equal(fixture.getOutbox()[0].payload.value, "planned");
});

test("JSON snapshots detach nested values without prototype mutation", async () => {
  const auditData = JSON.parse(
    '{"__proto__":{"polluted":true},"nested":[{"value":"planned"}]}',
  );
  const fixture = executorFixture({ audit: () => auditData });
  const result = await fixture.subject.transition(transitionRequest);
  auditData.nested[0].value = "mutated";
  auditData.__proto__.polluted = false;

  assert.equal(result.status, "committed");
  assert.equal(result.transition.auditData.nested[0].value, "planned");
  assert.equal(result.transition.auditData.__proto__.polluted, true);
  assert.equal(
    Object.getPrototypeOf(result.transition.auditData),
    Object.prototype,
  );
  assert.equal({}.polluted, undefined);
});

test("JSON snapshot failures retain the nested value path", async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const [payload, message] of [
    [{ nested: [{ invalid: undefined }] }, "$.nested[0].invalid is undefined"],
    [{ nested: [new Date()] }, "$.nested[0] is not JSON-safe"],
    [{ nested: cyclic }, "$.nested.self is cyclic"],
  ]) {
    const fixture = executorFixture({
      outbox: () => [{ topic: "invalid", payload }],
    });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_SERIALIZATION_FAILED" &&
        error.cause?.message === message,
    );
    assert.equal(fixture.order.includes("apply"), false);
  }
});

test("top-level request identity is snapshotted before asynchronous parsing", async () => {
  let resume;
  let parsing;
  const parserStarted = new Promise((resolve) => {
    parsing = resolve;
  });
  const parserResumed = new Promise((resolve) => {
    resume = resolve;
  });
  const fixture = executorFixture({
    input: {
      parse: async () => {
        parsing();
        await parserResumed;
        return { success: true, value: {} };
      },
    },
    metadataCallback: ({ request }) => request.metadata,
  });
  const request = {
    ...transitionRequest,
    idempotency: { ...transitionRequest.idempotency },
    input: {},
    metadata: { value: "planned" },
    correlationId: "correlation-1",
    causationId: "causation-1",
  };

  const pending = fixture.subject.transition(request);
  await parserStarted;
  request.id = "item-2";
  request.event = "other";
  request.expectedVersion = "9";
  request.idempotency.key = "other-key";
  request.metadata.value = "mutated";
  request.correlationId = "other-correlation";
  request.causationId = "other-causation";
  resume();

  const result = await pending;
  assert.equal(result.status, "committed");
  assert.equal(fixture.getClaim().resourceId, "item-1");
  assert.equal(fixture.getClaim().key, "key");
  assert.equal(fixture.getTransition().resourceId, "item-1");
  assert.equal(fixture.getTransition().event, "move");
  assert.equal(fixture.getTransition().metadata.value, "planned");
  assert.equal(fixture.getTransition().correlationId, "correlation-1");
  assert.equal(fixture.getTransition().causationId, "causation-1");
});

test("runtime boundaries return unknown-event and invalid-input", async () => {
  const fixture = executorFixture();
  assert.deepEqual(
    await fixture.subject.assess({
      id: "item-1",
      event: "missing",
      actor: undefined,
    }),
    { status: "unknown-event", event: "missing" },
  );
  const invalid = await fixture.subject.transition({
    ...transitionRequest,
    input: {},
  });
  assert.equal(invalid.status, "invalid-input");
});

test("assessment returns allowed and not-found outcomes", async () => {
  const allowed = await executorFixture().subject.assess({
    id: "item-1",
    event: "move",
    actor: undefined,
  });
  assert.deepEqual(allowed, {
    status: "allowed",
    currentState: "a",
    targetState: "b",
  });
  assert.deepEqual(
    await executorFixture({ loadPrimary: () => undefined }).subject.assess({
      id: "item-1",
      event: "move",
      actor: undefined,
    }),
    { status: "not-found" },
  );
});

test("advisory load and context failures preserve their causes", async () => {
  for (const [options, code] of [
    [
      {
        loadPrimary: () => {
          throw new Error("load");
        },
      },
      "INTERLOCK_PERSISTENCE_FAILED",
    ],
    [
      {
        context: () => {
          throw new Error("context");
        },
      },
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
    ],
  ]) {
    await assert.rejects(
      executorFixture(options).subject.assess({
        id: "item-1",
        event: "move",
        actor: undefined,
      }),
      (error) =>
        isInterlockError(error) &&
        error.code === code &&
        error.cause?.message ===
          (code === "INTERLOCK_PERSISTENCE_FAILED" ? "load" : "context"),
    );
  }
});

test("non-idempotent loaded-version transitions omit idempotency fields", async () => {
  let applied;
  const fixture = executorFixture({
    definitionVersion: "2026-01",
    observeApply: (args) => {
      applied = args;
    },
  });
  const result = await fixture.subject.transition({
    id: "item-1",
    event: "move",
    actor: undefined,
    expectedVersion: "use-loaded-version",
  });
  assert.equal(result.status, "committed");
  assert.equal(applied.expectedVersion, "1");
  assert.equal(fixture.order.includes("claim"), false);
  assert.equal(fixture.order.includes("complete"), false);
  assert.equal("idempotencyKey" in result.transition, false);
  assert.equal(result.transition.definitionVersion, "2026-01");
});

test("version and primary-update conflicts return canonical outcomes", async () => {
  const stale = await executorFixture().subject.transition({
    ...transitionRequest,
    expectedVersion: "2",
  });
  assert.deepEqual(stale, {
    status: "conflict",
    expected: "2",
    actual: { state: "a", version: "1" },
  });

  for (const [applied, expected] of [
    [{ status: "not-found" }, { status: "not-found" }],
    [{ status: "conflict" }, { status: "conflict", expected: "1" }],
    [
      { status: "conflict", actual: { state: "a", version: "2" } },
      {
        status: "conflict",
        expected: "1",
        actual: { state: "a", version: "2" },
      },
    ],
  ]) {
    const fixture = executorFixture({ applied });
    assert.deepEqual(
      await fixture.subject.transition(transitionRequest),
      expected,
    );
    assert.equal(fixture.order.includes("history"), false);
  }

  const actual = { state: "a", version: "2" };
  const copied = await executorFixture({
    applied: { status: "conflict", actual },
  }).subject.transition(transitionRequest);
  actual.state = "mutated";
  actual.version = "9";
  assert.deepEqual(copied, {
    status: "conflict",
    expected: "1",
    actual: { state: "a", version: "2" },
  });
});

test("idempotency claim conflicts and malformed results are distinguished", async () => {
  const conflict = executorFixture({ claim: { status: "conflict" } });
  assert.deepEqual(await conflict.subject.transition(transitionRequest), {
    status: "idempotency-conflict",
    key: "key",
  });
  for (const claim of [{}, { status: "claimed-wrong" }, { status: 1 }])
    await assert.rejects(
      executorFixture({ claim }).subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
    );
});

test("request identity and expected-version boundaries reject malformed values", async () => {
  for (const [request, status] of [
    [{ ...transitionRequest, id: "" }, "invalid-input"],
    [{ ...transitionRequest, event: "" }, "unknown-event"],
    [{ ...transitionRequest, expectedVersion: "0" }, "invalid-input"],
    [
      { ...transitionRequest, expectedVersion: "not-a-version" },
      "invalid-input",
    ],
  ]) {
    const result = await executorFixture().subject.transition(request);
    assert.equal(result.status, status);
  }
});

test("untyped request envelopes reject missing and malformed protocol fields", async () => {
  for (const request of [
    undefined,
    null,
    "request",
    { ...transitionRequest, correlationId: 123 },
    { ...transitionRequest, correlationId: "" },
    { ...transitionRequest, causationId: 123 },
    { ...transitionRequest, causationId: "" },
  ]) {
    const result = await executorFixture().subject.transition(request);
    assert.equal(result.status, "invalid-input");
  }
  assert.equal(
    (await executorFixture().subject.assess(undefined)).status,
    "invalid-input",
  );
});

test("outbox descriptors enforce shape and exact byte limits before writes", async () => {
  const accepted = executorFixture({
    maxOutboxPayloadBytes: 5,
    outbox: () => [{ topic: "probe", key: "item-1", payload: "123" }],
  });
  assert.equal(
    (await accepted.subject.transition(transitionRequest)).status,
    "committed",
  );
  assert.equal(accepted.getOutbox()[0].key, "item-1");

  for (const outbox of [
    () => "not-an-array",
    () => [null],
    () => [{ topic: "", payload: {} }],
    () => [{ topic: "probe", key: 1, payload: {} }],
  ]) {
    const fixture = executorFixture({ outbox });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
    );
    assert.equal(fixture.order.includes("apply"), false);
  }

  const oversized = executorFixture({
    maxOutboxPayloadBytes: 4,
    outbox: () => [{ topic: "probe", payload: "123" }],
  });
  await assert.rejects(
    oversized.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_SERIALIZATION_FAILED",
  );
  assert.equal(oversized.order.includes("apply"), false);
});

test("large outbox plans are fully validated before application writes", async () => {
  const descriptors = Array.from({ length: 501 }, (_, index) => ({
    topic: index === 500 ? "" : "probe",
    payload: { index },
  }));
  const fixture = executorFixture({ outbox: () => descriptors });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("executor configuration rejects invalid outbox limits", () => {
  for (const maxOutboxPayloadBytes of [0, -1, 1.5])
    assert.throws(
      () => executorFixture({ maxOutboxPayloadBytes }),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_INVALID",
    );
});

test("empty idempotency keys are rejected before a transaction", async () => {
  const fixture = executorFixture();
  const result = await fixture.subject.transition({
    ...transitionRequest,
    idempotency: { key: "" },
  });
  assert.equal(result.status, "invalid-input");
  assert.equal(fixture.order.includes("claim"), false);
});

test("untyped idempotency on an unsupported lifecycle is invalid input", async () => {
  const fixture = executorFixture({ omitIdempotency: true });
  const result = await fixture.subject.transition(transitionRequest);
  assert.deepEqual(result, {
    status: "invalid-input",
    issues: [
      {
        path: ["idempotency"],
        code: "IDEMPOTENCY_UNSUPPORTED",
        message: "This lifecycle does not support idempotency.",
      },
    ],
  });
  assert.equal(fixture.order.includes("claim"), false);
});

test("assess forces read-only transactions and strips private denial data", async () => {
  let transactionOptions;
  const publicDetails = { retryable: false };
  const fixture = executorFixture({
    transactionOptions: { isolation: "serializable", readOnly: false },
    observeTransactionOptions: (value) => {
      transactionOptions = value;
    },
    guards: [
      {
        name: "private",
        evaluate: () => {
          globalThis.queueMicrotask(() => {
            publicDetails.retryable = true;
          });
          return {
            allowed: false,
            denial: {
              code: "NO",
              message: "Not allowed",
              publicDetails,
              privateMessage: "secret",
              privateDetails: { secret: true },
            },
          };
        },
      },
    ],
  });
  const result = await fixture.subject.assess({
    id: "item-1",
    event: "move",
    actor: undefined,
  });
  assert.deepEqual(transactionOptions, {
    isolation: "serializable",
    readOnly: true,
  });
  assert.deepEqual(result.reason, {
    source: "guard",
    rule: "private",
    code: "NO",
    message: "Not allowed",
    publicDetails: { retryable: false },
  });
});

test("authorization denials are public and roll back authoritative work", async () => {
  const fixture = executorFixture({
    authorize: () => ({
      allowed: false,
      denial: {
        code: "FORBIDDEN",
        message: "Not allowed",
        privateMessage: "secret",
      },
    }),
  });
  assert.deepEqual(await fixture.subject.transition(transitionRequest), {
    status: "denied",
    event: "move",
    currentState: "a",
    targetState: "b",
    reason: {
      source: "authorization",
      code: "FORBIDDEN",
      message: "Not allowed",
    },
  });
  assert.equal(fixture.order.includes("apply"), false);
});

test("denial details must be JSON-safe", async () => {
  const fixture = executorFixture({
    authorize: () => ({
      allowed: false,
      denial: { code: "NO", publicDetails: { invalid: undefined } },
    }),
  });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION" &&
      error.cause instanceof TypeError,
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("callbacks cannot mutate the loaded concurrency boundary", async () => {
  const fixture = executorFixture({
    mutate: ({ resource }) => {
      resource.state = "b";
      return {};
    },
  });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("outbox IDs are allocated before application writes", async () => {
  let calls = 0;
  const fixture = executorFixture({
    outbox: () => [{ topic: "item.moved", payload: {} }],
    ids: () => {
      calls += 1;
      if (calls === 2) throw new Error("id allocation failed");
      return "transition-1";
    },
  });
  await assert.rejects(fixture.subject.transition(transitionRequest));
  assert.equal(fixture.order.includes("apply"), false);
});

test("a binding cannot substitute another resource identity", async () => {
  const fixture = executorFixture({ loadedId: "other" });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("an applied resource must match the requested identity, state, and version", async () => {
  for (const resource of [
    { id: "other", state: "b", version: "2" },
    { id: "item-1", state: "a", version: "2" },
    { id: "item-1", state: "b", version: "1" },
  ]) {
    const fixture = executorFixture({
      applied: { status: "applied", resource },
    });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
    );
    assert.equal(fixture.order.includes("history"), false);
  }
});

test("idempotent transitions reject unsupported isolation before transaction", async () => {
  for (const isolation of ["repeatable-read", "serializable"]) {
    const fixture = executorFixture({ transactionOptions: { isolation } });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DRIVER_UNSUPPORTED",
    );
    assert.equal(fixture.getClaim(), undefined);
  }
});

test("authoritative transitions reject read-only transaction options", async () => {
  const fixture = executorFixture({ transactionOptions: { readOnly: true } });
  await assert.rejects(
    fixture.subject.transition({
      ...transitionRequest,
      idempotency: undefined,
    }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("hydrateBeforeCommit must preserve identity, state, and version", async () => {
  for (const resource of [
    { id: "other", state: "b", version: "2" },
    { id: "item-1", state: "a", version: "2" },
    { id: "item-1", state: "b", version: "1" },
    {},
  ]) {
    const fixture = executorFixture({ hydrate: async () => resource });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
    );
  }
});

test("hydration failures preserve their cause", async () => {
  const cause = new Error("hydrate failed");
  const fixture = executorFixture({
    hydrate: async () => {
      throw cause;
    },
  });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_PERSISTENCE_FAILED" &&
      error.cause === cause,
  );
});

test("malformed parser, decision, and binding results fail with protocol errors", async () => {
  const cases = [
    executorFixture({
      input: { parse: () => ({ success: true }) },
    }).subject.transition({
      ...transitionRequest,
      input: {},
    }),
    executorFixture({
      authorize: () => ({ allowed: "yes" }),
    }).subject.transition(transitionRequest),
    executorFixture({ applied: { status: "weird" } }).subject.transition(
      transitionRequest,
    ),
    executorFixture({
      applied: { status: "conflict", actual: { state: "a", version: "bad" } },
    }).subject.transition(transitionRequest),
  ];
  const expected = [
    "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
    "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
    "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
    "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  ];
  for (let index = 0; index < cases.length; index += 1)
    await assert.rejects(
      cases[index],
      (error) => isInterlockError(error) && error.code === expected[index],
    );
});

test("callback and persistence failures preserve operation-specific codes and causes", async () => {
  const cases = [
    [
      "transaction options",
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      (cause) => ({
        transactionOptionsCallback: () => {
          throw cause;
        },
      }),
    ],
    [
      "clock",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        now: () => {
          throw cause;
        },
      }),
    ],
    [
      "input",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        input: {
          parse: () => {
            throw cause;
          },
        },
      }),
    ],
    [
      "fingerprint",
      "INTERLOCK_SERIALIZATION_FAILED",
      (cause) => ({
        fingerprintCallback: () => {
          throw cause;
        },
      }),
    ],
    [
      "claim",
      "INTERLOCK_PERSISTENCE_FAILED",
      (cause) => ({
        claimCallback: () => {
          throw cause;
        },
      }),
    ],
    [
      "load",
      "INTERLOCK_PERSISTENCE_FAILED",
      (cause) => ({
        loadPrimary: () => {
          throw cause;
        },
      }),
    ],
    [
      "context",
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      (cause) => ({
        context: () => {
          throw cause;
        },
      }),
    ],
    [
      "authorization",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        authorize: () => {
          throw cause;
        },
      }),
    ],
    [
      "guard",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        guards: [
          {
            name: "ready",
            evaluate: () => {
              throw cause;
            },
          },
        ],
      }),
    ],
    [
      "mutation",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        mutate: () => {
          throw cause;
        },
      }),
    ],
    [
      "audit",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        audit: () => {
          throw cause;
        },
      }),
    ],
    [
      "outbox projection",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        outbox: () => {
          throw cause;
        },
      }),
    ],
    [
      "actor",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        actorCallback: () => {
          throw cause;
        },
      }),
    ],
    [
      "metadata",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        metadataCallback: () => {
          throw cause;
        },
      }),
    ],
    [
      "ID allocation",
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      (cause) => ({
        ids: () => {
          throw cause;
        },
      }),
    ],
    [
      "primary",
      "INTERLOCK_PERSISTENCE_FAILED",
      (cause) => ({
        applyPrimary: () => {
          throw cause;
        },
      }),
    ],
    [
      "related",
      "INTERLOCK_PERSISTENCE_FAILED",
      (cause) => ({
        applyRelated: () => {
          throw cause;
        },
      }),
    ],
    [
      "history",
      "INTERLOCK_HISTORY_FAILED",
      (cause) => ({
        insertTransition: () => {
          throw cause;
        },
      }),
    ],
    [
      "outbox insertion",
      "INTERLOCK_OUTBOX_FAILED",
      (cause) => ({
        insertOutbox: () => {
          throw cause;
        },
      }),
    ],
    [
      "completion",
      "INTERLOCK_PERSISTENCE_FAILED",
      (cause) => ({
        complete: () => {
          throw cause;
        },
      }),
    ],
  ];
  for (const [label, code, options] of cases) {
    const cause = new Error(label);
    const request =
      label === "input"
        ? { ...transitionRequest, input: {} }
        : transitionRequest;
    await assert.rejects(
      executorFixture(options(cause)).subject.transition(request),
      (error) =>
        isInterlockError(error) && error.code === code && error.cause === cause,
      label,
    );
  }
});

test("unsupported Standard Schema versions are rejected at construction", () => {
  assert.throws(
    () =>
      defineLifecycle()({
        name: "standard",
        states: ["a", "b"],
        history: { resourceType: "item" },
        events: {
          move: {
            from: ["a"],
            to: "b",
            input: {
              "~standard": { version: 2, validate: () => ({ value: {} }) },
            },
            mutate: () => ({}),
          },
        },
      }),
    (error) =>
      isInterlockError(error) && error.code === "INTERLOCK_DEFINITION_INVALID",
  );
});

test("malformed lifecycle, binding, and driver construction fails stably", () => {
  assert.throws(
    () => defineLifecycle()(null),
    (error) =>
      isInterlockError(error) && error.code === "INTERLOCK_DEFINITION_INVALID",
  );
  const fixture = executorFixture();
  for (const replacement of [{ driver: {} }, { binding: {} }])
    assert.throws(
      () =>
        createInterlock({
          lifecycle: defineLifecycle()({
            name: "valid",
            states: ["a", "b"],
            history: { resourceType: "item" },
            events: { move: { from: ["a"], to: "b", mutate: () => ({}) } },
          }),
          driver: replacement.driver ?? fixture,
          binding: replacement.binding ?? {},
        }),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_INVALID",
    );
});

test("consistency declarations are validated, copied, and frozen", () => {
  const declaration = { strategy: "custom", notes: "planned" };
  const fixture = executorFixture({ consistency: () => declaration });
  const result = fixture.subject.consistency("move");
  declaration.notes = "mutated";
  assert.deepEqual(result, { strategy: "custom", notes: "planned" });
  assert.equal(Object.isFrozen(result), true);
  assert.throws(
    () => executorFixture({ consistency: { strategy: "unknown", notes: "x" } }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
  );
});

test("duplicate records must match the normalized request", async () => {
  for (const transition of [
    { ...validDuplicate, lifecycle: "other" },
    { ...validDuplicate, resourceId: "other" },
    { ...validDuplicate, event: "other" },
    { ...validDuplicate, idempotencyKey: "other" },
    { ...validDuplicate, requestFingerprint: "other" },
    { ...validDuplicate, previousVersion: "bad" },
    { ...validDuplicate, occurredAt: new Date("invalid") },
    { ...validDuplicate, id: "" },
    { ...validDuplicate, actorId: 1 },
    { ...validDuplicate, correlationId: 1 },
    { ...validDuplicate, auditData: new Date() },
    { ...validDuplicate, metadata: { invalid: undefined } },
  ]) {
    const fixture = executorFixture({
      claim: { status: "duplicate", transition },
    });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
    );
    assert.equal(fixture.order.includes("authorize"), false);
  }
});

test("duplicates replay historical edges after lifecycle graph changes", async () => {
  const historical = {
    ...validDuplicate,
    fromState: "historical-draft",
    toState: "historical-approved",
    definitionVersion: "1",
  };
  const fixture = executorFixture({
    claim: { status: "duplicate", transition: historical },
  });
  const result = await fixture.subject.transition(transitionRequest);
  assert.equal(result.status, "committed");
  assert.equal(result.duplicate, true);
  assert.equal(result.transition.fromState, "historical-draft");
  assert.equal(result.transition.toState, "historical-approved");
});

test("valid duplicates skip policy and canonical history cannot be substituted", async () => {
  const duplicate = executorFixture({
    claim: { status: "duplicate", transition: validDuplicate },
  });
  const replay = await duplicate.subject.transition(transitionRequest);
  assert.equal(replay.status, "committed");
  assert.equal(replay.duplicate, true);
  assert.equal(duplicate.order.includes("authorize"), false);

  const inserted = executorFixture({
    insertTransition: (value) => {
      value.id = "driver-substitute";
      return { ...value, id: "returned-substitute" };
    },
  });
  const committed = await inserted.subject.transition(transitionRequest);
  assert.equal(committed.status, "committed");
  assert.equal(committed.transition.id, "transition-1");
});

test("cyclic outbox data fails with a typed error before writes", async () => {
  const payload = {};
  payload.self = payload;
  const fixture = executorFixture({
    outbox: () => [{ topic: "cyclic", payload }],
  });
  await assert.rejects(
    fixture.subject.transition(transitionRequest),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_SERIALIZATION_FAILED",
  );
  assert.equal(fixture.order.includes("apply"), false);
});

test("PostgreSQL driver qualifies default and custom schemas safely", async () => {
  const run = async (schema) => {
    const queries = [];
    const client = {
      on() {},
      off() {},
      release() {},
      async query(text) {
        queries.push(text);
        return { rowCount: 1, rows: [{ fingerprint: "fingerprint" }] };
      },
    };
    const driver = new PostgresDriver(
      { connect: async () => client },
      schema === undefined ? {} : { schema },
    );
    await driver.transaction((transaction) =>
      driver.claimIdempotency(transaction, {
        lifecycle: "item",
        resourceId: "item-1",
        key: "key",
        fingerprint: "fingerprint",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    return queries.join("\n");
  };
  assert.match(await run(), /"public"\."interlock_idempotency"/);
  assert.match(
    await run('Tenant "One"; DROP SCHEMA public; --'),
    /"Tenant ""One""; DROP SCHEMA public; --"\."interlock_idempotency"/,
  );
  for (const schema of ["", "a".repeat(64), "bad\0schema", 1])
    assert.throws(
      () => new PostgresDriver({}, { schema }),
      (error) =>
        isInterlockError(error) &&
        error.code === "INTERLOCK_DEFINITION_INVALID",
    );
});

test("PostgreSQL operational codes remain distinct from domain conflicts", () => {
  assert.equal(
    normalizePostgresError({ code: "40001" }).code,
    "INTERLOCK_SERIALIZATION_CONFLICT",
  );
  assert.equal(
    normalizePostgresError({ code: "40P01" }).code,
    "INTERLOCK_DEADLOCK",
  );
  assert.equal(
    normalizePostgresError({ code: "55P03" }).code,
    "INTERLOCK_LOCK_TIMEOUT",
  );
  assert.equal(
    normalizePostgresError({ code: "57014" }).code,
    "INTERLOCK_CANCELLED",
  );
});

test("PostgreSQL transient errors survive executor operation wrapping", async () => {
  for (const [code, expected] of [
    ["40001", "INTERLOCK_SERIALIZATION_CONFLICT"],
    ["40P01", "INTERLOCK_DEADLOCK"],
    ["55P03", "INTERLOCK_LOCK_TIMEOUT"],
    ["57014", "INTERLOCK_CANCELLED"],
  ]) {
    const failure = Object.assign(new Error(`PostgreSQL ${code}`), { code });
    const client = {
      on: () => undefined,
      off: () => undefined,
      query: async (sql) => {
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK")
          return { rowCount: 0, rows: [] };
        throw failure;
      },
      release: () => undefined,
    };
    const driver = new PostgresDriver({ connect: async () => client });
    const fixture = executorFixture({ driver });
    await assert.rejects(
      fixture.subject.transition(transitionRequest),
      (error) => isInterlockError(error) && error.code === expected,
      code,
    );
  }
});

test("Interlock errors are recognizable across physical package copies", () => {
  const duplicateCopyError = Object.assign(new Error("failed"), {
    name: "InterlockError",
    code: "INTERLOCK_TRANSACTION_FAILED",
  });
  assert.equal(isInterlockError(duplicateCopyError), true);
});

test("connection loss during commit reports an unknown commit outcome", async () => {
  let releases = 0;
  const client = {
    on: () => undefined,
    off: () => undefined,
    query: async (sql) => {
      if (sql === "COMMIT")
        throw Object.assign(new Error("connection lost"), { code: "08006" });
      return { rowCount: 0, rows: [] };
    },
    release: () => {
      releases += 1;
    },
  };
  const driver = new PostgresDriver({ connect: async () => client });
  await assert.rejects(
    driver.transaction(async () => "done"),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_COMMIT_OUTCOME_UNKNOWN",
  );
  assert.equal(releases, 1);
});

test("connection acquisition failures are normalized", async () => {
  const failure = Object.assign(new Error("connection refused"), {
    code: "ECONNREFUSED",
  });
  const driver = new PostgresDriver({
    connect: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    driver.transaction(async () => "done"),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_TRANSACTION_FAILED" &&
      error.cause === failure,
  );
});

test("release failures do not replace transaction failures", async () => {
  const original = new Error("operation failed");
  const client = {
    on: () => undefined,
    off: () => undefined,
    query: async () => ({ rowCount: 0, rows: [] }),
    release: () => {
      throw new Error("release failed");
    },
  };
  const driver = new PostgresDriver({ connect: async () => client });
  await assert.rejects(
    driver.transaction(async () => {
      throw original;
    }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_TRANSACTION_FAILED" &&
      error.cause === original,
  );
});

test("listener cleanup failures do not replace transaction success", async () => {
  const client = {
    on: () => undefined,
    off: () => {
      throw new Error("listener cleanup failed");
    },
    query: async () => ({ rowCount: 0, rows: [] }),
    release: () => undefined,
  };
  const driver = new PostgresDriver({ connect: async () => client });
  assert.equal(await driver.transaction(async () => "done"), "done");
});

test("rollback failure does not replace the original execution failure", async () => {
  const original = new Error("operation failed");
  const rollback = new Error("rollback failed");
  const client = {
    on: () => undefined,
    off: () => undefined,
    query: async (sql) => {
      if (sql === "ROLLBACK") throw rollback;
      return { rowCount: 0, rows: [] };
    },
    release: () => undefined,
  };
  const driver = new PostgresDriver({ connect: async () => client });
  await assert.rejects(
    driver.transaction(async () => {
      throw original;
    }),
    (error) =>
      isInterlockError(error) &&
      error.code === "INTERLOCK_TRANSACTION_FAILED" &&
      error.cause === original,
  );
});
