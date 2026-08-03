import test from "node:test";
import assert from "node:assert/strict";
import { permitLifecycle } from "../src/domain/permits/lifecycle.js";
import { permitConsistency } from "../src/domain/permits/binding.js";
import { loadConfig } from "../src/config.js";

test("reference app imports only public package exports", () => {
  assert.equal(permitLifecycle.name, "permit");
  assert.match(import.meta.resolve("@jajego/interlock"), /dist\/index\.js$/);
  assert.match(
    import.meta.resolve("@jajego/interlock-postgres/migration.sql"),
    /001_interlock\.sql$/,
  );
});

test("consistency declarations match event-specific authoritative reads", () => {
  assert.equal(permitConsistency("submit").strategy, "aggregate-version");
  assert.equal(permitConsistency("beginReview").strategy, "row-locking");
  assert.equal(permitConsistency("approve").strategy, "row-locking");
  assert.equal(permitConsistency("reject").strategy, "row-locking");
  assert.equal(permitConsistency("cancel").strategy, "row-locking");
});

test("environment validation rejects missing and malformed values", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: "postgres://x", PORT: "bad" }),
    /PORT/,
  );
});
