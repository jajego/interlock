import { randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import type { PermitActor } from "../src/domain/permits/types.js";

export const actors = {
  applicant: { id: "applicant-a", tenantId: "tenant-a", role: "applicant" },
  reviewer: { id: "reviewer-a", tenantId: "tenant-a", role: "reviewer" },
  admin: { id: "admin-a", tenantId: "tenant-a", role: "admin" },
  outsider: { id: "applicant-b", tenantId: "tenant-b", role: "applicant" },
} as const satisfies Record<string, PermitActor>;

export function testDatabase() {
  return createDatabase(loadConfig().databaseUrl);
}

export async function reset(database: Database) {
  await database.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS reference_fail_primary ON permits;
    DROP TRIGGER IF EXISTS reference_fail_related ON review_decisions;
    DROP TRIGGER IF EXISTS reference_fail_history ON interlock.interlock_transition_history;
    DROP TRIGGER IF EXISTS reference_fail_outbox ON interlock.interlock_outbox;
    DROP TRIGGER IF EXISTS reference_fail_completion ON interlock.interlock_idempotency;
  `);
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      delivered_notifications, review_decisions, review_assignments,
      permit_documents, permits, tenant_memberships, users, tenants,
      interlock.interlock_outbox, interlock.interlock_idempotency,
      interlock.interlock_transition_history
    CASCADE
  `);
  for (const [id, name] of [
    ["tenant-a", "North County"],
    ["tenant-b", "South County"],
  ] as const)
    await database.tenant.create({ data: { id, name } });
  for (const [id, name] of [
    ["applicant-a", "Avery Applicant"],
    ["reviewer-a", "Riley Reviewer"],
    ["admin-a", "Alex Admin"],
    ["applicant-b", "Blake Applicant"],
  ] as const)
    await database.user.create({ data: { id, name } });
  for (const actor of Object.values(actors))
    await database.tenantMembership.upsert({
      where: {
        tenantId_userId: { tenantId: actor.tenantId, userId: actor.id },
      },
      update: { role: actor.role },
      create: { tenantId: actor.tenantId, userId: actor.id, role: actor.role },
    });
  await database
    .$executeRawUnsafe("DELETE FROM reference_test_failures")
    .catch(() => {});
}

export async function permit(
  database: Database,
  options: {
    tenantId?: string;
    applicantUserId?: string;
    state?: string;
    withDocument?: boolean;
    assignedReviewerId?: string;
    permitNumber?: number;
  } = {},
) {
  const id = randomUUID();
  await database.permit.create({
    data: {
      id,
      tenantId: options.tenantId ?? "tenant-a",
      permitNumber: options.permitNumber ?? 100,
      applicantName: "Applicant",
      applicantUserId: options.applicantUserId ?? "applicant-a",
      state: options.state ?? "draft",
    },
  });
  if (options.withDocument)
    await database.permitDocument.create({
      data: {
        id: randomUUID(),
        permitId: id,
        kind: "plan",
        storageKey: `${id}/plan.pdf`,
      },
    });
  if (options.assignedReviewerId)
    await database.reviewAssignment.create({
      data: {
        id: randomUUID(),
        permitId: id,
        reviewerId: options.assignedReviewerId,
      },
    });
  return database.permit.findUniqueOrThrow({ where: { id } });
}

export function headers(
  actor: PermitActor,
  version: string,
  key: string = randomUUID(),
) {
  return {
    "x-tenant-id": actor.tenantId,
    "x-user-id": actor.id,
    "expected-version": version,
    "idempotency-key": key,
  };
}

export async function counts(database: Database, id: string) {
  const [permitRow, decisions, history, outbox, claims] = await Promise.all([
    database.permit.findUniqueOrThrow({ where: { id } }),
    database.reviewDecision.count({ where: { permitId: id } }),
    database.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*)::bigint count FROM interlock.interlock_transition_history WHERE resource_id = ${id}`,
    database.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*)::bigint count FROM interlock.interlock_outbox WHERE resource_id = ${id}`,
    database.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*)::bigint count FROM interlock.interlock_idempotency WHERE resource_id = ${id}`,
  ]);
  return {
    state: permitRow.state,
    version: String(permitRow.version),
    decisions,
    history: Number(history[0]?.count ?? 0n),
    outbox: Number(outbox[0]?.count ?? 0n),
    claims: Number(claims[0]?.count ?? 0n),
  };
}
