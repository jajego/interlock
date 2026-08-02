import type { BindingFor, RelatedDataConsistency } from "@interlock/core";
import type { Permit } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { StatementObserver, Transaction } from "../../db.js";
import { permitLifecycle } from "./lifecycle.js";
import type { ActorRole, PermitResource, PermitState } from "./types.js";

const ignoreStatement: StatementObserver = () => {};

function state(value: string): PermitState {
  switch (value) {
    case "draft":
    case "submitted":
    case "under_review":
    case "approved":
    case "rejected":
    case "cancelled":
      return value;
    default:
      throw new Error(`Unknown permit state: ${value}`);
  }
}

function resource(row: Permit): PermitResource {
  return {
    id: row.id,
    tenantId: row.tenantId,
    permitNumber: row.permitNumber,
    state: state(row.state),
    version: String(row.version),
    applicantName: row.applicantName,
    applicantUserId: row.applicantUserId,
  };
}

function actorRole(value: string): ActorRole | undefined {
  switch (value) {
    case "applicant":
    case "reviewer":
    case "admin":
      return value;
    default:
      return undefined;
  }
}

async function membershipRole(
  transaction: Transaction,
  tenantId: string,
  userId: string,
  authoritative: boolean,
  observe: StatementObserver,
) {
  observe("membership");
  const rows = authoritative
    ? await transaction.$queryRaw<Array<{ role: string }>>`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND active
        FOR SHARE
      `
    : await transaction.$queryRaw<Array<{ role: string }>>`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND active
      `;
  const value = rows[0]?.role;
  return value === undefined ? undefined : actorRole(value);
}

export function permitConsistency(
  event: keyof typeof permitLifecycle.events,
): RelatedDataConsistency {
  switch (event) {
    case "submit":
      return {
        strategy: "aggregate-version",
        notes:
          "Actor membership is row-locked; document writes increment the version-checked permit aggregate.",
      };
    case "beginReview":
      return {
        strategy: "row-locking",
        notes:
          "Actor and candidate reviewer memberships are stabilized with row locks.",
      };
    case "approve":
    case "reject":
      return {
        strategy: "row-locking",
        notes:
          "Actor membership and current review assignment are stabilized with row locks.",
      };
    case "cancel":
      return {
        strategy: "row-locking",
        notes: "Actor membership is stabilized with a row lock.",
      };
  }
}

export function createPermitBinding(
  observe: StatementObserver = ignoreStatement,
): BindingFor<Transaction, typeof permitLifecycle> {
  return {
    transactionOptions: () => ({ isolation: "read-committed" }),
    loadPrimary: async (transaction, operation) => {
      observe("primary-load");
      const row = await transaction.permit.findFirst({
        where: { id: operation.id, tenantId: operation.actor.tenantId },
      });
      return row ? resource(row) : null;
    },
    getId: (permit) => permit.id,
    getState: (permit) => permit.state,
    getVersion: (permit) => permit.version,
    contextFactory: {
      create: async (transaction, operation) => {
        const authoritative = operation.mode === "authoritative";
        const role = await membershipRole(
          transaction,
          operation.actor.tenantId,
          operation.actor.id,
          authoritative,
          observe,
        );
        switch (operation.event) {
          case "submit": {
            observe("documents");
            const documentCount = await transaction.permitDocument.count({
              where: { permitId: operation.id },
            });
            return { ...(role ? { actorRole: role } : {}), documentCount };
          }
          case "approve":
          case "reject": {
            observe("assignment");
            const rows = authoritative
              ? await transaction.$queryRaw<Array<{ reviewer_id: string }>>`
                  SELECT reviewer_id FROM review_assignments
                  WHERE permit_id = ${operation.id}
                  FOR SHARE
                `
              : await transaction.$queryRaw<Array<{ reviewer_id: string }>>`
                  SELECT reviewer_id FROM review_assignments
                  WHERE permit_id = ${operation.id}
                `;
            const reviewerId = rows[0]?.reviewer_id;
            return {
              ...(role ? { actorRole: role } : {}),
              ...(reviewerId ? { assignedReviewerId: reviewerId } : {}),
            };
          }
          case "beginReview":
            return {
              ...(role ? { actorRole: role } : {}),
              reviewerEligible: async (reviewerId: string) => {
                const candidateRole = await membershipRole(
                  transaction,
                  operation.actor.tenantId,
                  reviewerId,
                  authoritative,
                  observe,
                );
                return (
                  candidateRole === "reviewer" || candidateRole === "admin"
                );
              },
            };
          case "cancel":
            return role ? { actorRole: role } : {};
        }
      },
    },
    applyPrimary: async (transaction, args) => {
      observe("primary-update");
      const updated = await transaction.permit.updateMany({
        where: {
          id: args.resource.id,
          tenantId: args.operation.actor.tenantId,
          state: args.fromState,
          version: BigInt(args.expectedVersion),
        },
        data: {
          state: args.toState,
          version: BigInt(args.nextVersion),
        },
      });
      return updated.count === 1
        ? {
            status: "applied",
            resource: {
              ...args.resource,
              state: state(args.toState),
              version: String(args.nextVersion),
            },
          }
        : { status: "conflict" };
    },
    applyRelated: async (transaction, args) => {
      switch (args.operation.event) {
        case "beginReview":
          observe("related-assignment");
          await transaction.reviewAssignment.upsert({
            where: { permitId: args.updatedResource.id },
            update: { reviewerId: args.operation.mutation.reviewerId },
            create: {
              id: randomUUID(),
              permitId: args.updatedResource.id,
              reviewerId: args.operation.mutation.reviewerId,
            },
          });
          return;
        case "approve":
          observe("related-decision");
          await transaction.reviewDecision.create({
            data: {
              id: randomUUID(),
              permitId: args.updatedResource.id,
              transitionId: args.transitionId,
              reviewerId: args.operation.mutation.reviewerId,
              decision: "approved",
              reason: args.operation.mutation.note,
            },
          });
          return;
        case "reject":
          observe("related-decision");
          await transaction.reviewDecision.create({
            data: {
              id: randomUUID(),
              permitId: args.updatedResource.id,
              transitionId: args.transitionId,
              reviewerId: args.operation.mutation.reviewerId,
              decision: "rejected",
              reason: args.operation.mutation.reason,
            },
          });
          return;
        case "submit":
        case "cancel":
          return;
        default: {
          const exhaustive: never = args.operation;
          return exhaustive;
        }
      }
    },
    consistency: permitConsistency,
  };
}

export const permitBinding = createPermitBinding();
