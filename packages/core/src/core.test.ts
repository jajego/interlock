import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalHash,
  canonicalJson,
  defineLifecycle,
  incrementVersion,
  parseVersionToken,
} from "./index.js";

test("version tokens reject unsafe counters and increment PostgreSQL BIGINT values", () => {
  assert.equal(parseVersionToken("0").success, false);
  const parsed = parseVersionToken("9007199254740993");
  assert.equal(parsed.success, true);
  if (parsed.success)
    assert.equal(incrementVersion(parsed.value), "9007199254740994");
});

test("canonical JSON ignores object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
});

test("definitions reject accidental self transitions", () => {
  assert.throws(() =>
    defineLifecycle()({
      name: "bad",
      states: ["open"],
      history: { resourceType: "item" },
      events: { close: { from: ["open"], to: "open", mutate: () => ({}) } },
    }),
  );
});
