import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const id = randomUUID();
try {
  await prisma.$executeRawUnsafe(
    "CREATE TABLE IF NOT EXISTS spike_applications (id TEXT PRIMARY KEY, state TEXT NOT NULL, version BIGINT NOT NULL)",
  );
  await prisma.spikeApplication.create({
    data: { id, state: "review", version: 1n },
  });
  const pids = await prisma.$transaction(async (tx) => {
    const seen: number[] = [];
    const pid = async () =>
      seen.push(
        Number(
          (
            await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() pid`
          )[0]?.pid,
        ),
      );
    await pid();
    await tx.spikeApplication.update({
      where: { id },
      data: { state: "approved", version: 2n },
    });
    await pid();
    const transitionId = randomUUID();
    await tx.$executeRaw`INSERT INTO interlock_transition_history (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,occurred_at) VALUES (${transitionId},'spike','application',${id},'approve','review','approved',1,2,now())`;
    await pid();
    await tx.$executeRaw`INSERT INTO interlock_idempotency (lifecycle,resource_id,idempotency_key,fingerprint,transition_id,created_at,completed_at) VALUES ('spike',${id},'key','fingerprint',${transitionId},now(),now())`;
    await pid();
    await tx.$executeRaw`INSERT INTO interlock_outbox (id,lifecycle,resource_type,resource_id,transition_id,topic,payload,created_at) VALUES (${randomUUID()},'spike','application',${id},${transitionId},'approved','{}',now())`;
    await pid();
    return seen;
  });
  assert.equal(
    new Set(pids).size,
    1,
    "all writes must share one Prisma transaction connection",
  );
} finally {
  await prisma.$disconnect();
}
