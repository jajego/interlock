import type { FastifyRequest } from "fastify";
import type { Database } from "./db.js";
import type { ActorRole, PermitActor } from "./domain/permits/types.js";

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function authenticate(
  database: Database,
  request: FastifyRequest,
): Promise<PermitActor | undefined> {
  const tenantId = header(request, "x-tenant-id");
  const userId = header(request, "x-user-id");
  if (!tenantId || !userId) return undefined;
  const membership = await database.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });
  if (
    !membership ||
    !["applicant", "reviewer", "admin"].includes(membership.role)
  )
    return undefined;
  return { id: userId, tenantId, role: membership.role as ActorRole };
}
