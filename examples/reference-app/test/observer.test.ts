import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { ReferenceMetrics } from "../src/interlock/observer.js";
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
    assert.deepEqual(
      metrics.operations.map((value) => value.outcome),
      ["committed", "duplicate", "denied"],
    );
    for (const labels of [...metrics.operations, ...metrics.durations]) {
      assert.deepEqual(
        Object.keys(labels).sort(),
        ("outcome" in labels
          ? ["event", "lifecycle", "mode", "outcome"]
          : ["durationMs", "event", "lifecycle", "mode"]
        ).sort(),
      );
    }
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
    const failed = captured
      .observations()
      .find((value) => value.type === "interlock.operation.failed");
    assert.equal(failed?.code, "INTERLOCK_PERSISTENCE_FAILED");
    assert.equal(failed?.phase, "primary-write");
    assert.deepEqual(metrics.failures, [
      {
        lifecycle: "permit",
        event: "submit",
        code: "INTERLOCK_PERSISTENCE_FAILED",
        phase: "primary-write",
      },
    ]);
  } finally {
    await app.close();
  }
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
