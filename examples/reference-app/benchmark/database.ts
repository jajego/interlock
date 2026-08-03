import { canonicalHash, type OutboxInsert } from "@jajego/interlock";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { loadConfig } from "../src/config.js";
import { createDatabase, type TransactionTiming } from "../src/db.js";
import { optionalNoteSchema } from "../src/domain/permits/lifecycle.js";
import { createPermitService } from "../src/domain/permits/service.js";
import { PrismaInterlockDriver } from "../src/interlock/prisma-driver.js";
import { actors, permit, reset } from "../test/helpers.js";
import { environment, measurePaths } from "./report.js";

const database = createDatabase(loadConfig().databaseUrl);
let permitNumber = 20_000;

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function cleanup(resourceId: string, verify = true) {
  if (verify) {
    const rows = await database.$queryRaw<
      Array<{
        state: string;
        decisions: bigint;
        history: bigint;
        outbox: bigint;
        claims: bigint;
      }>
    >`
      SELECT p.state,
        (SELECT count(*) FROM review_decisions WHERE permit_id = p.id) decisions,
        (SELECT count(*) FROM interlock.interlock_transition_history WHERE resource_id = p.id) history,
        (SELECT count(*) FROM interlock.interlock_outbox WHERE resource_id = p.id) outbox,
        (SELECT count(*) FROM interlock.interlock_idempotency WHERE resource_id = p.id) claims
      FROM permits p WHERE p.id = ${resourceId}
    `;
    const row = rows[0];
    if (
      row?.state !== "approved" ||
      row.decisions !== 1n ||
      row.history !== 1n ||
      row.outbox !== 1n ||
      row.claims !== 1n
    )
      throw new Error("Measured path did not persist the equivalent work.");
  }
  await database.$transaction(async (transaction) => {
    await transaction.reviewDecision.deleteMany({
      where: { permitId: resourceId },
    });
    await transaction.$executeRaw`
      DELETE FROM interlock.interlock_outbox WHERE resource_id = ${resourceId}
    `;
    await transaction.$executeRaw`
      DELETE FROM interlock.interlock_idempotency WHERE resource_id = ${resourceId}
    `;
    await transaction.$executeRaw`
      DELETE FROM interlock.interlock_transition_history WHERE resource_id = ${resourceId}
    `;
    await transaction.permit.delete({ where: { id: resourceId } });
  });
}

const interlockCounts = new Set<number>();
const handwrittenCounts = new Set<number>();
const interlockTimings: TransactionTiming[] = [];
const handwrittenTimings: TransactionTiming[] = [];

async function prepareInterlock() {
  const row = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
    permitNumber: permitNumber++,
  });
  const statements: string[] = [];
  const service = createPermitService(database, {
    observeStatement: (statement) => statements.push(statement),
    observeTransaction: (timing) => interlockTimings.push(timing),
  });
  return {
    run: async () => {
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
      interlockCounts.add(statements.length);
    },
    cleanup: () => cleanup(row.id),
  };
}

async function prepareHandwritten() {
  const row = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
    permitNumber: permitNumber++,
  });
  return {
    run: async () => {
      let statements = 0;
      const input = v.safeParse(optionalNoteSchema, {});
      if (!input.success) throw new Error("invalid input");
      const validatedInput =
        input.output.note === undefined ? {} : { note: input.output.note };
      const transitionId = randomUUID();
      const outboxId = randomUUID();
      const decisionId = randomUUID();
      const key = randomUUID();
      const occurredAt = new Date();
      const fingerprint = canonicalHash({
        resourceId: row.id,
        event: "approve",
        input: validatedInput,
        actorId: actors.reviewer.id,
        tenantId: actors.reviewer.tenantId,
        expectedVersion: "1",
      });
      const started = process.hrtime.bigint();
      let entered = started;
      let finished = started;
      await database.$transaction(
        async (transaction) => {
          entered = process.hrtime.bigint();
          statements += 1;
          const claimed = await transaction.$executeRaw`
            INSERT INTO interlock.interlock_idempotency
              (lifecycle,resource_id,idempotency_key,fingerprint,created_at)
            VALUES ('permit',${row.id},${key},${fingerprint},${occurredAt})
            ON CONFLICT DO NOTHING
          `;
          if (claimed !== 1) throw new Error("idempotency claim failed");

          statements += 1;
          const loaded = await transaction.permit.findFirstOrThrow({
            where: { id: row.id, tenantId: actors.reviewer.tenantId },
          });
          statements += 1;
          const memberships = await transaction.$queryRaw<
            Array<{ role: string }>
          >`
            SELECT role FROM tenant_memberships
            WHERE tenant_id = ${actors.reviewer.tenantId}
              AND user_id = ${actors.reviewer.id}
              AND active
            FOR SHARE
          `;
          statements += 1;
          const assignments = await transaction.$queryRaw<
            Array<{ reviewer_id: string }>
          >`
            SELECT reviewer_id FROM review_assignments
            WHERE permit_id = ${row.id}
            FOR SHARE
          `;
          if (
            loaded.state !== "under_review" ||
            loaded.version !== 1n ||
            memberships[0]?.role !== "reviewer" ||
            assignments[0]?.reviewer_id !== actors.reviewer.id
          )
            throw new Error("policy rejected");

          statements += 1;
          const updated = await transaction.permit.updateMany({
            where: {
              id: row.id,
              tenantId: actors.reviewer.tenantId,
              state: "under_review",
              version: 1n,
            },
            data: { state: "approved", version: 2n },
          });
          if (updated.count !== 1) throw new Error("conflict");

          statements += 1;
          const history = await transaction.$executeRaw`
            INSERT INTO interlock.interlock_transition_history
              (id,lifecycle,resource_type,resource_id,event,from_state,to_state,
               previous_version,next_version,actor_type,actor_id,audit_data,
               metadata,idempotency_key,request_fingerprint,definition_version,
               occurred_at)
            VALUES (${transitionId},'permit','permit',${row.id},'approve',
              'under_review','approved',1,2,'user',${actors.reviewer.id},
              ${JSON.stringify({ noteProvided: false })}::jsonb,
              ${JSON.stringify({ tenantId: row.tenantId, permitNumber: row.permitNumber })}::jsonb,
              ${key},${fingerprint},'1',${occurredAt})
          `;
          if (history !== 1) throw new Error("history row count");

          statements += 1;
          await transaction.reviewDecision.create({
            data: {
              id: decisionId,
              permitId: row.id,
              transitionId,
              reviewerId: actors.reviewer.id,
              decision: "approved",
            },
          });

          statements += 1;
          const outbox = await transaction.$executeRaw`
            INSERT INTO interlock.interlock_outbox
              (id,lifecycle,resource_type,resource_id,transition_id,topic,
               message_key,payload,created_at)
            VALUES (${outboxId},'permit','permit',${row.id},${transitionId},
              'permit.approved',${row.id},
              ${JSON.stringify({ permitId: row.id, tenantId: row.tenantId, transitionId })}::jsonb,
              ${occurredAt})
          `;
          if (outbox !== 1) throw new Error("outbox row count");

          statements += 1;
          const completed = await transaction.$executeRaw`
            UPDATE interlock.interlock_idempotency
            SET transition_id = ${transitionId}, completed_at = ${occurredAt}
            WHERE lifecycle = 'permit' AND resource_id = ${row.id}
              AND idempotency_key = ${key} AND transition_id IS NULL
          `;
          if (completed !== 1) throw new Error("completion row count");
          finished = process.hrtime.bigint();
        },
        { isolationLevel: "ReadCommitted" },
      );
      const ended = process.hrtime.bigint();
      handwrittenTimings.push({
        poolWaitMs: Number(entered - started) / 1_000_000,
        transactionMs: Number(finished - entered) / 1_000_000,
        totalMs: Number(ended - started) / 1_000_000,
      });
      handwrittenCounts.add(statements);
    },
    cleanup: () => cleanup(row.id),
  };
}

async function queryCountProbes() {
  const duplicateStatements: string[] = [];
  const duplicateRow = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
    permitNumber: permitNumber++,
  });
  const setup = createPermitService(database);
  const request = {
    id: duplicateRow.id,
    actor: actors.reviewer,
    expectedVersion: "1",
    idempotencyKey: "duplicate-probe",
  };
  await setup.approve(request, {});
  const duplicate = createPermitService(database, {
    observeStatement: (statement) => duplicateStatements.push(statement),
  });
  await duplicate.approve(request, {});

  const conflictStatements: string[] = [];
  const conflictRow = await permit(database, {
    state: "under_review",
    assignedReviewerId: actors.reviewer.id,
    permitNumber: permitNumber++,
  });
  await database.permit.update({
    where: { id: conflictRow.id },
    data: { version: 2n },
  });
  const conflict = createPermitService(database, {
    observeStatement: (statement) => conflictStatements.push(statement),
  });
  await conflict.approve(
    {
      id: conflictRow.id,
      actor: actors.reviewer,
      expectedVersion: "1",
      idempotencyKey: "conflict-probe",
    },
    {},
  );

  const outboxStatements: string[] = [];
  const driver = new PrismaInterlockDriver(database, {
    observeStatement: (statement) => outboxStatements.push(statement),
  });
  const probeTransitionId = randomUUID();
  await database.$executeRaw`
    INSERT INTO interlock.interlock_transition_history
      (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,occurred_at)
    VALUES (${probeTransitionId},'probe','probe','probe','probe','before','after',1,2,${new Date()})
  `;
  const outboxMessages: OutboxInsert[] = Array.from(
    { length: 5 },
    (_, index) => ({
      id: randomUUID(),
      lifecycle: "probe",
      resourceType: "probe",
      resourceId: "probe",
      transitionId: probeTransitionId,
      topic: "probe",
      payload: { index },
      createdAt: new Date(),
    }),
  );
  await database.$transaction((transaction) =>
    driver.insertOutbox(transaction, outboxMessages),
  );
  const result = {
    duplicateReplay: duplicateStatements.length,
    conflict: conflictStatements.length,
    fiveOutboxRows: outboxStatements.length,
  };
  await cleanup(duplicateRow.id, false);
  await cleanup(conflictRow.id, false);
  await database.$executeRaw`
    DELETE FROM interlock.interlock_outbox WHERE lifecycle = 'probe'
  `;
  await database.$executeRaw`
    DELETE FROM interlock.interlock_transition_history WHERE id = ${probeTransitionId}
  `;
  return result;
}

try {
  await reset(database);
  const postgres = await database.$queryRaw<
    Array<{ version: string }>
  >`SELECT current_setting('server_version') version`;
  const reports = await measurePaths(
    [
      { name: "interlock-same-guarantee-approval", prepare: prepareInterlock },
      {
        name: "handwritten-same-guarantee-approval",
        prepare: prepareHandwritten,
      },
    ],
    { warmups: 10, iterations: 100, rounds: 3 },
  );
  if (
    interlockCounts.size !== 1 ||
    handwrittenCounts.size !== 1 ||
    [...interlockCounts][0] !== 9 ||
    [...handwrittenCounts][0] !== 9
  )
    throw new Error("Measured query counts changed between samples.");
  const probes = await queryCountProbes();
  if (
    probes.duplicateReplay !== 2 ||
    probes.conflict !== 2 ||
    probes.fiveOutboxRows !== 1
  )
    throw new Error("Query-count probe changed unexpectedly.");
  process.stdout.write(
    `${JSON.stringify(
      {
        layer: "postgres-comparison",
        environment: environment({
          postgres: postgres[0]?.version,
          prisma: "7.9.1",
          poolMax: 10,
        }),
        fairness:
          "Both paths use the same input schema, active-membership and assignment row locks, authorization, state/version CAS, history/audit/metadata, related decision, outbox payload, idempotency protocol, row-count checks, and Read Committed isolation.",
        unavoidableDifference:
          "Interlock validates its public protocol objects in addition to the application work; the handwritten path has no equivalent reusable protocol boundary.",
        transactionControlIncludedInQueryCounts: false,
        queryCounts: {
          interlockNormal: [...interlockCounts][0],
          handwrittenNormal: [...handwrittenCounts][0],
          firstIdempotent: [...interlockCounts][0],
          oneOutboxRow: [...interlockCounts][0],
          ...probes,
        },
        transactionTimingMs: {
          interlock: {
            poolWaitMean: mean(
              interlockTimings.map((value) => value.poolWaitMs),
            ),
            insideTransactionMean: mean(
              interlockTimings.map((value) => value.transactionMs),
            ),
          },
          handwritten: {
            poolWaitMean: mean(
              handwrittenTimings.map((value) => value.poolWaitMs),
            ),
            insideTransactionMean: mean(
              handwrittenTimings.map((value) => value.transactionMs),
            ),
          },
        },
        reports,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await database.$disconnect();
}
