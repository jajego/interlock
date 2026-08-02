import assert from "node:assert/strict";
import test from "node:test";
import { measure, measurePaths } from "../benchmark/report.js";

test("benchmark preparation is excluded from measured latency", async () => {
  const report = await measure(
    "setup-outside-clock",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { run: async () => {} };
    },
    { warmups: 0, iterations: 3, rounds: 1 },
  );
  assert.ok(report.maxMs < 5);
});

test("paired benchmark paths alternate order by round", async () => {
  const order: string[] = [];
  await measurePaths(
    ["interlock", "handwritten"].map((name) => ({
      name,
      prepare: async () => ({ run: async () => void order.push(name) }),
    })),
    { warmups: 0, iterations: 1, rounds: 2 },
  );
  assert.deepEqual(order, [
    "interlock",
    "handwritten",
    "handwritten",
    "interlock",
  ]);
});

test("small samples omit p99 and serial rate is explicitly named", async () => {
  const report = await measure("small", async () => ({ run: async () => {} }), {
    warmups: 0,
    iterations: 2,
    rounds: 1,
  });
  assert.equal(report.p99Ms, undefined);
  assert.equal("operationsPerSecond" in report, false);
  assert.equal(typeof report.serialEquivalentOperationsPerSecond, "number");
  assert.equal(report.percentileMethod, "nearest-rank");
});

test("p99 is reported only once 200 samples exist", async () => {
  const report = await measure(
    "large-enough",
    async () => ({ run: async () => {} }),
    { warmups: 0, iterations: 200, rounds: 1 },
  );
  assert.equal(typeof report.p99Ms, "number");
});
