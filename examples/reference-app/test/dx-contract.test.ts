import test from "node:test";
import assert from "node:assert/strict";
import { permitLifecycle } from "../src/domain/permits/lifecycle.js";
import { loadConfig } from "../src/config.js";

test("reference app imports only public package exports", () => {
  assert.equal(permitLifecycle.name, "permit");
  assert.match(import.meta.resolve("@interlock/core"), /dist\/index\.js$/);
  assert.match(
    import.meta.resolve("@interlock/postgres/migration.sql"),
    /001_interlock\.sql$/,
  );
});

test("environment validation rejects missing and malformed values", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: "postgres://x", PORT: "bad" }),
    /PORT/,
  );
});
