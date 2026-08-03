import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import {
  createInterlockObserver,
  ReferenceMetrics,
} from "../src/interlock/observer.js";
import {
  actors,
  counts,
  headers,
  permit,
  reset,
  testDatabase,
} from "./helpers.js";

const database = testDatabase();
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

function capture() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      level: "info",
      stream: { write: (line: string) => lines.push(line) },
    },
    observations: () =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.category === "interlock"),
  };
}

test("reference observer logs committed, duplicate, and denied outcomes safely", async () => {
  const captured = capture();
  const metrics = new ReferenceMetrics();
  const app = createApp(database, { logger: captured.logger, metrics });
  try {
    const row = await permit(database, { withDocument: true });
    const request = {
      method: "POST" as const,
      url: `/permits/${row.id}/events/submit`,
      headers: headers(actors.applicant, String(row.version), "observer-key"),
      payload: { note: "request-secret" },
    };
    assert.equal((await app.inject(request)).statusCode, 200);
    assert.equal((await app.inject(request)).json().duplicate, true);

    const review = await permit(database, {
      state: "under_review",
      assignedReviewerId: actors.reviewer.id,
      permitNumber: 101,
    });
    const denied = await app.inject({
      method: "POST",
      url: `/permits/${review.id}/events/approve`,
      headers: headers(actors.applicant, "1", "denied-key"),
      payload: { note: "denied-secret" },
    });
    assert.equal(denied.statusCode, 403);

    const completed = captured
      .observations()
      .filter((value) => value.type === "interlock.operation.completed");
    assert.deepEqual(
      completed.map((value) => value.outcome),
      ["committed", "duplicate", "denied"],
    );
    assert.doesNotMatch(
      JSON.stringify(completed),
      /request-secret|denied-secret|observer-key/,
    );
    const operationCounts = [...metrics.operationCounts.values()];
    assert.deepEqual(
      operationCounts.map((value) => value.labels.outcome),
      ["committed", "duplicate", "denied"],
    );
    for (const { labels, count } of operationCounts) {
      assert.equal(count, 1);
      assert.deepEqual(
        Object.keys(labels).sort(),
        ["event", "lifecycle", "mode", "outcome"].sort(),
      );
    }
    for (const summary of metrics.durationSummaries.values())
      assert.deepEqual(
        Object.keys(summary.labels).sort(),
        ["event", "lifecycle", "mode"].sort(),
      );
  } finally {
    await app.close();
  }
});

test("reference observer logs operational code and phase", async () => {
  const captured = capture();
  const metrics = new ReferenceMetrics();
  const app = createApp(database, { logger: captured.logger, metrics });
  try {
    const row = await permit(database, { withDocument: true });
    await database.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION reference_observer_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'observer failure probe'; END $$;
      CREATE TRIGGER reference_sensitive_primary BEFORE UPDATE ON permits
      FOR EACH ROW EXECUTE FUNCTION reference_observer_failure();
    `);
    const response = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/submit`,
      headers: headers(actors.applicant, String(row.version), "failure-key"),
      payload: {},
    });
    assert.equal(response.statusCode, 500);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/permits/${row.id}/events/submit`,
          headers: headers(
            actors.applicant,
            String(row.version),
            "failure-key",
          ),
          payload: {},
        })
      ).statusCode,
      500,
    );
    const failed = captured
      .observations()
      .find((value) => value.type === "interlock.operation.failed");
    assert.equal(failed?.code, "INTERLOCK_PERSISTENCE_FAILED");
    assert.equal(failed?.phase, "primary-write");
    assert.deepEqual(
      [...metrics.failureCounts.values()],
      [
        {
          labels: {
            lifecycle: "permit",
            event: "submit",
            code: "INTERLOCK_PERSISTENCE_FAILED",
            phase: "primary-write",
          },
          count: 2,
        },
      ],
    );
  } finally {
    await app.close();
  }
});

test("reference metrics aggregate bounded labels and normalize unknown events", () => {
  const logs: Record<string, unknown>[] = [];
  const metrics = new ReferenceMetrics();
  const observer = createInterlockObserver(
    { info: (fields) => logs.push(fields) },
    metrics,
  );
  const base = {
    lifecycle: "permit",
    resourceId: "high-cardinality-resource",
    mode: "transition" as const,
    correlationId: "high-cardinality-correlation",
  };
  for (const durationMs of [2, 3])
    observer.observe({
      ...base,
      type: "interlock.operation.completed",
      operationId: `operation-${durationMs}`,
      event: "submit",
      outcome: "committed",
      transitionId: `transition-${durationMs}`,
      durationMs,
      outboxMessageCount: 0,
    });
  for (const [index, event] of [
    "caller-event-one",
    "caller-event-two",
  ].entries())
    observer.observe({
      ...base,
      type: "interlock.operation.completed",
      operationId: `unknown-${index}`,
      event,
      outcome: "unknown-event",
      durationMs: 1,
    });
  for (const operationId of ["failed-one", "failed-two"])
    observer.observe({
      ...base,
      type: "interlock.operation.failed",
      operationId,
      event: "submit",
      code: "INTERLOCK_PERSISTENCE_FAILED",
      phase: "primary-write",
      commitOutcome: "not-committed",
      durationMs: 1,
    });

  assert.deepEqual(
    logs.slice(2, 4).map((entry) => entry.event),
    ["caller-event-one", "caller-event-two"],
  );
  assert.equal(metrics.operationCounts.size, 2);
  assert.equal(metrics.durationSummaries.size, 2);
  assert.equal(metrics.failureCounts.size, 1);
  const committed = [...metrics.operationCounts.values()].find(
    ({ labels }) => labels.outcome === "committed",
  );
  assert.equal(committed?.count, 2);
  const committedDuration = [...metrics.durationSummaries.values()].find(
    ({ labels }) => labels.event === "submit",
  );
  assert.deepEqual(
    committedDuration && {
      count: committedDuration.count,
      totalMs: committedDuration.totalMs,
      maxMs: committedDuration.maxMs,
    },
    { count: 2, totalMs: 5, maxMs: 3 },
  );
  const unknown = [...metrics.operationCounts.values()].find(
    ({ labels }) => labels.outcome === "unknown-event",
  );
  assert.equal(unknown?.labels.event, "__unknown__");
  assert.equal(unknown?.count, 2);
  const unknownDuration = [...metrics.durationSummaries.values()].find(
    ({ labels }) => labels.event === "__unknown__",
  );
  assert.deepEqual(
    unknownDuration && {
      count: unknownDuration.count,
      totalMs: unknownDuration.totalMs,
      maxMs: unknownDuration.maxMs,
    },
    { count: 2, totalMs: 2, maxMs: 1 },
  );
  assert.equal([...metrics.failureCounts.values()][0]?.count, 2);
  for (const entry of [
    ...metrics.operationCounts.values(),
    ...metrics.durationSummaries.values(),
    ...metrics.failureCounts.values(),
  ])
    assert.deepEqual(
      Object.keys(entry.labels).sort(),
      ("outcome" in entry.labels
        ? ["event", "lifecycle", "mode", "outcome"]
        : "mode" in entry.labels
          ? ["event", "lifecycle", "mode"]
          : ["code", "event", "lifecycle", "phase"]
      ).sort(),
    );
});

test("reference observer failure cannot change HTTP or committed state", async () => {
  const app = createApp(database, {
    interlockObserver: {
      observe() {
        throw new Error("telemetry unavailable");
      },
    },
  });
  try {
    const row = await permit(database, { withDocument: true });
    const response = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/submit`,
      headers: headers(
        actors.applicant,
        String(row.version),
        "observer-throws",
      ),
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await counts(database, row.id), {
      state: "submitted",
      version: "3",
      decisions: 0,
      history: 1,
      outbox: 0,
      claims: 1,
    });
  } finally {
    await app.close();
  }
});
