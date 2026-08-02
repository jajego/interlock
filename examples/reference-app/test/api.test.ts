import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { actors, headers, permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

test("normal lifecycle, validation, denial, and tenancy work through HTTP", async () => {
  const app = createApp(database);
  try {
    const row = await permit(database, { withDocument: true });
    const submit = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/submit`,
      headers: headers(actors.applicant, String(row.version), "submit"),
      payload: {},
    });
    assert.equal(submit.statusCode, 200);
    const begin = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/beginReview`,
      headers: headers(actors.reviewer, "3", "begin"),
      payload: { reviewerId: actors.reviewer.id },
    });
    assert.equal(begin.statusCode, 200);
    const denied = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/approve`,
      headers: headers(actors.applicant, "4", "denied"),
      payload: {},
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().reason.code, "REVIEWER_NOT_ASSIGNED");
    const approved = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/approve`,
      headers: headers(actors.reviewer, "4", "approve"),
      payload: { note: "Reviewed" },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().resource.state, "approved");
    const outsider = await app.inject({
      method: "GET",
      url: `/permits/${row.id}`,
      headers: {
        "x-tenant-id": actors.outsider.tenantId,
        "x-user-id": actors.outsider.id,
      },
    });
    assert.equal(outsider.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("rejection, resubmission, cancellation, invalid input, and missing resources", async () => {
  const app = createApp(database);
  try {
    const row = await permit(database, {
      state: "under_review",
      withDocument: true,
      assignedReviewerId: actors.reviewer.id,
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/reject`,
      headers: headers(actors.reviewer, String(row.version), "invalid"),
      payload: {},
    });
    assert.equal(invalid.statusCode, 400);
    const rejected = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/reject`,
      headers: headers(actors.reviewer, String(row.version), "reject"),
      payload: { reason: "Incomplete" },
    });
    assert.equal(rejected.statusCode, 200);
    const submitted = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/submit`,
      headers: headers(actors.applicant, "3", "resubmit"),
      payload: {},
    });
    assert.equal(submitted.statusCode, 200);
    const cancelled = await app.inject({
      method: "POST",
      url: `/permits/${row.id}/events/cancel`,
      headers: headers(actors.applicant, "4", "cancel"),
      payload: { reason: "Withdrawn" },
    });
    assert.equal(cancelled.statusCode, 200);
    const missing = await app.inject({
      method: "POST",
      url: "/permits/missing/events/submit",
      headers: headers(actors.applicant, "1", "missing"),
      payload: {},
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("tenant-local permit numbers may overlap while internal IDs remain unique", async () => {
  const first = await permit(database, { permitNumber: 42 });
  const second = await permit(database, {
    tenantId: "tenant-b",
    applicantUserId: "applicant-b",
    permitNumber: 42,
  });
  assert.notEqual(first.id, second.id);
  assert.equal(first.permitNumber, second.permitNumber);
});
