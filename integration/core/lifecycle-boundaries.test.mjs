import test from "node:test";
import assert from "node:assert/strict";
import { defineLifecycle } from "../../packages/core/dist/index.js";

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

test("lifecycle definitions snapshot every supported field once", async () => {
  const schema = Object.defineProperties(
    { marker: "schema" },
    {
      parse: changing(function () {
        return { success: true, value: this.marker };
      }, 123),
    },
  );
  const guard = Object.defineProperties(
    {},
    {
      name: changing("ready", 123),
      evaluate: changing(function () {
        return { allowed: this.name === "ready" };
      }, 123),
    },
  );
  const event = Object.defineProperties(
    {},
    {
      from: changing(["a"], ["evil"]),
      to: changing("b", "evil"),
      input: changing(schema, null),
      authorize: changing(function () {
        return this.to;
      }, 123),
      guards: changing([guard], null),
      mutate: changing(function () {
        return this.to;
      }, 123),
      audit: changing(function () {
        return this.to;
      }, 123),
      outbox: changing(function () {
        return this.to;
      }, 123),
    },
  );
  let eventReads = 0;
  const eventRegistry = new Proxy(
    Object.assign(Object.create({ inherited: event }), { move: event }),
    {
      get(target, property, receiver) {
        if (property === "move") {
          eventReads += 1;
          return eventReads === 1 ? event : null;
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const history = Object.defineProperties(
    {},
    {
      resourceType: changing("item", 123),
      actor: changing(function () {
        return { actorType: this.resourceType };
      }, 123),
      metadata: changing(function () {
        return this.resourceType;
      }, 123),
    },
  );
  const idempotency = Object.defineProperties(
    {},
    {
      fingerprint: changing(function () {
        return typeof this.fingerprint;
      }, 123),
    },
  );
  const rootReads = new Map();
  const definition = new Proxy(
    {
      name: "snapshot",
      definitionVersion: "1",
      states: ["a", "b"],
      events: eventRegistry,
      history,
      idempotency,
    },
    {
      get(target, property, receiver) {
        const reads = (rootReads.get(property) ?? 0) + 1;
        rootReads.set(property, reads);
        if (reads > 1) return null;
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const lifecycle = defineLifecycle()(definition);
  const accepted = lifecycle.getEvent("move");
  assert.equal(lifecycle.name, "snapshot");
  assert.equal(lifecycle.definitionVersion, "1");
  assert.deepEqual(lifecycle.states, ["a", "b"]);
  assert.deepEqual(accepted.from, ["a"]);
  assert.equal(accepted.to, "b");
  assert.deepEqual(await lifecycle.parseInput(accepted, null), {
    success: true,
    value: "schema",
  });
  assert.equal(accepted.authorize({}), "b");
  assert.deepEqual(accepted.guards[0].evaluate({}), { allowed: true });
  assert.equal(accepted.mutate({}), "b");
  assert.equal(accepted.audit({}), "b");
  assert.equal(accepted.outbox({}), "b");
  assert.deepEqual(lifecycle.history.actor(), { actorType: "item" });
  assert.equal(lifecycle.history.metadata({}), "item");
  assert.equal(lifecycle.idempotency.fingerprint({}), "function");
  assert.equal(lifecycle.getEvent("inherited"), undefined);
  assert.equal(eventReads, 1);
  for (const field of [
    "name",
    "definitionVersion",
    "states",
    "events",
    "history",
    "idempotency",
  ])
    assert.equal(rootReads.get(field), 1, field);
});

test("invalid first lifecycle getter values are rejected", () => {
  assert.throws(
    () =>
      defineLifecycle()(
        Object.defineProperties(
          {},
          {
            name: changing(123, "later-valid"),
            definitionVersion: changing(undefined, "1"),
            states: changing(["a", "b"], ["a", "b"]),
            events: changing({}, {}),
            history: changing(
              { resourceType: "item" },
              { resourceType: "item" },
            ),
            idempotency: changing(undefined, undefined),
          },
        ),
      ),
    /Lifecycle name is invalid/,
  );
});
