import {
  allow,
  canonicalHash,
  defineEvent,
  defineLifecycle,
  deny,
  type InputIssue,
  type InputSchema,
} from "@interlock/core";
import type { PermitActor, PermitContext, PermitResource } from "./types.js";

function objectInput<Value>(
  parse: (
    input: Record<string, unknown>,
  ) =>
    { ok: true; value: Value } | { ok: false; issues: readonly InputIssue[] },
): InputSchema<unknown, Value> {
  return {
    parse(input) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return {
          success: false,
          issues: [
            {
              path: ["input"],
              code: "INVALID_INPUT",
              message: "Expected an object.",
            },
          ],
        };
      const result = parse(input as Record<string, unknown>);
      return result.ok
        ? { success: true, value: result.value }
        : { success: false, issues: result.issues };
    },
  };
}

const optionalNote = objectInput<{ note?: string }>((input) => {
  const note = input.note;
  return note === undefined
    ? { ok: true, value: {} }
    : typeof note === "string" && note.length <= 2_000
      ? { ok: true, value: { note } }
      : {
          ok: false,
          issues: [
            {
              path: ["input", "note"],
              code: "INVALID_INPUT",
              message: "Note must be at most 2000 characters.",
            },
          ],
        };
});
const reviewerInput = objectInput<{ reviewerId: string }>((input) =>
  typeof input.reviewerId === "string" && input.reviewerId.length > 0
    ? { ok: true, value: { reviewerId: input.reviewerId } }
    : {
        ok: false,
        issues: [
          {
            path: ["input", "reviewerId"],
            code: "INVALID_INPUT",
            message: "reviewerId is required.",
          },
        ],
      },
);
const rejectInput = objectInput<{ reason: string }>((input) =>
  typeof input.reason === "string" &&
  input.reason.trim().length > 0 &&
  input.reason.length <= 2_000
    ? { ok: true, value: { reason: input.reason } }
    : {
        ok: false,
        issues: [
          {
            path: ["input", "reason"],
            code: "INVALID_INPUT",
            message: "A rejection reason is required.",
          },
        ],
      },
);
const cancelInput = objectInput<{ reason?: string }>((input) => {
  const reason = input.reason;
  return reason === undefined
    ? { ok: true, value: {} }
    : typeof reason === "string" && reason.length <= 2_000
      ? { ok: true, value: { reason } }
      : {
          ok: false,
          issues: [
            {
              path: ["input", "reason"],
              code: "INVALID_INPUT",
              message: "Reason must be at most 2000 characters.",
            },
          ],
        };
});

const event = defineEvent<PermitResource, PermitActor, PermitContext>();
const reviewerPolicy = ({
  actor,
  context,
}: {
  actor: PermitActor;
  context: PermitContext;
}) =>
  actor.role === "admin" ||
  (actor.role === "reviewer" && context.assignedReviewerId === actor.id)
    ? allow()
    : deny({ code: "REVIEWER_NOT_ASSIGNED" });

export const permitLifecycle = defineLifecycle<
  PermitResource,
  PermitActor,
  PermitContext
>()({
  name: "permit",
  definitionVersion: "1",
  states: [
    "draft",
    "submitted",
    "under_review",
    "approved",
    "rejected",
    "cancelled",
  ],
  history: {
    resourceType: "permit",
    actor: (actor) => ({ actorType: "user", actorId: actor.id }),
    metadata: ({ actor, resource }) => ({
      tenantId: actor.tenantId,
      permitNumber: resource.permitNumber,
    }),
  },
  idempotency: {
    fingerprint: ({ resourceId, event, parsedInput, actor, expectedVersion }) =>
      canonicalHash({
        resourceId,
        event,
        input: JSON.parse(JSON.stringify(parsedInput)),
        actorId: actor.id,
        tenantId: actor.tenantId,
        expectedVersion,
      }),
  },
  events: {
    submit: event(optionalNote, {
      from: ["draft", "rejected"],
      to: "submitted",
      authorize: ({ actor, resource }) =>
        actor.role === "admin" || actor.id === resource.applicantUserId
          ? allow()
          : deny({ code: "APPLICANT_REQUIRED" }),
      guards: [
        {
          name: "documents-present",
          evaluate: ({ context }) =>
            context.documentCount > 0
              ? allow()
              : deny({ code: "DOCUMENTS_REQUIRED" }),
        },
      ],
      mutate: ({ input }) => ({ note: input.note ?? null }),
      audit: ({ input }) => ({ noteProvided: input.note !== undefined }),
    }),
    beginReview: event(reviewerInput, {
      from: ["submitted"],
      to: "under_review",
      authorize: ({ actor }) =>
        actor.role === "reviewer" || actor.role === "admin"
          ? allow()
          : deny({ code: "REVIEWER_REQUIRED" }),
      mutate: ({ input }) => ({ reviewerId: input.reviewerId }),
      audit: ({ input }) => ({ reviewerId: input.reviewerId }),
    }),
    approve: event(optionalNote, {
      from: ["under_review"],
      to: "approved",
      authorize: reviewerPolicy,
      mutate: ({ input, actor }) => ({
        reviewerId: actor.id,
        note: input.note ?? null,
      }),
      audit: ({ input }) => ({ noteProvided: input.note !== undefined }),
      outbox: ({ resource, transitionId }) => [
        {
          topic: "permit.approved",
          key: resource.id,
          payload: {
            permitId: resource.id,
            tenantId: resource.tenantId,
            transitionId,
          },
        },
      ],
    }),
    reject: event(rejectInput, {
      from: ["under_review"],
      to: "rejected",
      authorize: reviewerPolicy,
      mutate: ({ input, actor }) => ({
        reviewerId: actor.id,
        reason: input.reason,
      }),
      audit: ({ input }) => ({ reason: input.reason }),
    }),
    cancel: event(cancelInput, {
      from: ["draft", "submitted", "under_review", "rejected"],
      to: "cancelled",
      authorize: ({ actor, resource }) =>
        actor.role === "admin" || actor.id === resource.applicantUserId
          ? allow()
          : deny({ code: "APPLICANT_REQUIRED" }),
      mutate: ({ input }) => ({ reason: input.reason ?? null }),
      audit: ({ input }) => ({ reason: input.reason ?? null }),
    }),
  },
});
