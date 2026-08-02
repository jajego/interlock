import { createDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";

const database = createDatabase(loadConfig().databaseUrl);
try {
  for (const [id, name] of [
    ["tenant-a", "North County"],
    ["tenant-b", "South County"],
  ] as const)
    await database.tenant.upsert({
      where: { id },
      update: { name },
      create: { id, name },
    });
  for (const [id, name] of [
    ["applicant-a", "Avery Applicant"],
    ["reviewer-a", "Riley Reviewer"],
    ["admin-a", "Alex Admin"],
    ["applicant-b", "Blake Applicant"],
  ] as const)
    await database.user.upsert({
      where: { id },
      update: { name },
      create: { id, name },
    });
  for (const [tenantId, userId, role] of [
    ["tenant-a", "applicant-a", "applicant"],
    ["tenant-a", "reviewer-a", "reviewer"],
    ["tenant-a", "admin-a", "admin"],
    ["tenant-b", "applicant-b", "applicant"],
  ] as const)
    await database.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      update: { role },
      create: { tenantId, userId, role },
    });
} finally {
  await database.$disconnect();
}
