import {
  allow,
  canonicalHash,
  defineEvent,
  defineLifecycle,
  deny,
} from "@jajego/interlock";
import * as v from "valibot";
import type { PermitActor, PermitContext, PermitResource } from "./types.js";

export const optionalNoteSchema = v.object({
  note: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
});
const reviewerInput = v.object({
  reviewerId: v.pipe(v.string(), v.nonEmpty()),
});
const rejectInput = v.object({
  reason: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(2_000)),
});
const cancelInput = v.object({
  reason: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
});

const event = defineEvent<PermitResource, PermitActor, PermitContext>();
const reviewerPolicy = ({
  actor,
  context,
}: {
  actor: PermitActor;
  context: PermitContext;
}) =>
  context.actorRole === "admin" ||
  (context.actorRole === "reviewer" && context.assignedReviewerId === actor.id)
    ? allow()
    : deny({
        code: "REVIEWER_NOT_ASSIGNED",
        privateMessage:
          "Authoritative membership or assignment rejected actor.",
      });

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
    submit: event(optionalNoteSchema, {
      from: ["draft", "rejected"],
      to: "submitted",
      authorize: ({ actor, context, resource }) =>
        context.actorRole === "admin" ||
        (context.actorRole === "applicant" &&
          actor.id === resource.applicantUserId)
          ? allow()
          : deny({ code: "APPLICANT_REQUIRED" }),
      guards: [
        {
          name: "documents-present",
          evaluate: ({ context }) =>
            (context.documentCount ?? 0) > 0
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
      authorize: ({ context }) =>
        context.actorRole === "reviewer" || context.actorRole === "admin"
          ? allow()
          : deny({ code: "REVIEWER_REQUIRED" }),
      guards: [
        {
          name: "candidate-reviewer-eligible",
          evaluate: async ({ context, input }) =>
            context.reviewerEligible &&
            (await context.reviewerEligible(input.reviewerId))
              ? allow()
              : deny({ code: "REVIEWER_INELIGIBLE" }),
        },
      ],
      mutate: ({ input }) => ({ reviewerId: input.reviewerId }),
      audit: ({ input }) => ({ reviewerId: input.reviewerId }),
    }),
    approve: event(optionalNoteSchema, {
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
      authorize: ({ actor, context, resource }) =>
        context.actorRole === "admin" ||
        (context.actorRole === "applicant" &&
          actor.id === resource.applicantUserId)
          ? allow()
          : deny({ code: "APPLICANT_REQUIRED" }),
      mutate: ({ input }) => ({ reason: input.reason ?? null }),
      audit: ({ input }) => ({ reason: input.reason ?? null }),
    }),
  },
});
