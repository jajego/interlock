import { primaryRowOnly, type BindingFor } from "@interlock/core";
import type { Permit } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Transaction } from "../../db.js";
import { permitLifecycle } from "./lifecycle.js";
import type { PermitResource, PermitState } from "./types.js";

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

export const permitBinding: BindingFor<Transaction, typeof permitLifecycle> = {
  transactionOptions: () => ({ isolation: "read-committed" }),
  loadPrimary: async (transaction, operation) => {
    await transaction.$executeRaw`
      SELECT set_config('app.tenant_id', ${operation.actor.tenantId}, true),
             set_config('app.user_id', ${operation.actor.id}, true)
    `;
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
      const [documentCount, assignment] = await Promise.all([
        transaction.permitDocument.count({ where: { permitId: operation.id } }),
        transaction.reviewAssignment.findUnique({
          where: { permitId: operation.id },
        }),
      ]);
      return {
        documentCount,
        ...(assignment ? { assignedReviewerId: assignment.reviewerId } : {}),
      };
    },
  },
  applyPrimary: async (transaction, args) => {
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
  consistency: primaryRowOnly,
};
