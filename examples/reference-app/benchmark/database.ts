import { randomUUID } from "node:crypto";
import { createPermitService } from "../src/domain/permits/service.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { actors, permit, reset } from "../test/helpers.js";
import { environment, measure } from "./report.js";

const database = createDatabase(loadConfig().databaseUrl);
const service = createPermitService(database);
try {
  await reset(database);
  const postgres = await database.$queryRaw<
    Array<{ version: string }>
  >`SELECT current_setting('server_version') version`;
  let permitNumber = 20_000;
  const interlock = await measure(
    "interlock-same-guarantee-approval",
    async () => {
      const row = await permit(database, {
        state: "under_review",
        assignedReviewerId: actors.reviewer.id,
        permitNumber: permitNumber++,
      });
      const result = await service.approve(
        {
          id: row.id,
          actor: actors.reviewer,
          expectedVersion: "1",
          idempotencyKey: randomUUID(),
        },
        {},
      );
      if (result.status !== "committed") throw new Error(result.status);
    },
    { warmups: 3, iterations: 15 },
  );
  const handwritten = await measure(
    "handwritten-same-guarantee-approval",
    async () => {
      const row = await permit(database, {
        state: "under_review",
        assignedReviewerId: actors.reviewer.id,
        permitNumber: permitNumber++,
      });
      const transitionId = randomUUID();
      const key = randomUUID();
      await database.$transaction(async (transaction) => {
        await transaction.$executeRaw`INSERT INTO interlock.interlock_idempotency (lifecycle,resource_id,idempotency_key,fingerprint,created_at) VALUES ('handwritten',${row.id},${key},${key},now())`;
        const loaded = await transaction.permit.findFirstOrThrow({
          where: { id: row.id, tenantId: actors.reviewer.tenantId },
        });
        const assignment = await transaction.reviewAssignment.findUniqueOrThrow(
          { where: { permitId: row.id } },
        );
        if (
          loaded.state !== "under_review" ||
          assignment.reviewerId !== actors.reviewer.id
        )
          throw new Error("policy");
        const updated = await transaction.permit.updateMany({
          where: { id: row.id, state: "under_review", version: 1n },
          data: { state: "approved", version: 2n },
        });
        if (updated.count !== 1) throw new Error("conflict");
        await transaction.$executeRaw`INSERT INTO interlock.interlock_transition_history (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,actor_type,actor_id,idempotency_key,request_fingerprint,occurred_at) VALUES (${transitionId},'handwritten','permit',${row.id},'approve','under_review','approved',1,2,'user',${actors.reviewer.id},${key},${key},now())`;
        await transaction.reviewDecision.create({
          data: {
            id: randomUUID(),
            permitId: row.id,
            transitionId,
            reviewerId: actors.reviewer.id,
            decision: "approved",
          },
        });
        await transaction.$executeRaw`INSERT INTO interlock.interlock_outbox (id,lifecycle,resource_type,resource_id,transition_id,topic,payload,created_at) VALUES (${randomUUID()},'handwritten','permit',${row.id},${transitionId},'permit.approved',${JSON.stringify({ permitId: row.id })}::jsonb,now())`;
        await transaction.$executeRaw`UPDATE interlock.interlock_idempotency SET transition_id=${transitionId},completed_at=now() WHERE lifecycle='handwritten' AND resource_id=${row.id} AND idempotency_key=${key}`;
      });
    },
    { warmups: 3, iterations: 15 },
  );
  process.stdout.write(
    `${JSON.stringify({ layer: "postgres-comparison", environment: environment({ postgres: postgres[0]?.version, prisma: "7.9.1" }), fairness: "Both paths validate policy, CAS state/version, write a related decision, history, idempotency, and one outbox row.", queryCounts: { interlock: 11, handwritten: 10, transactionControlIncluded: true }, reports: [interlock, handwritten] }, null, 2)}\n`,
  );
} finally {
  await database.$disconnect();
}
