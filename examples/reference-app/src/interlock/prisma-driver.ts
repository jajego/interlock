import {
  InterlockError,
  parseVersionToken,
  type IdempotencyClaim,
  type IdempotencyClaimResult,
  type OutboxInsert,
  type TransactionDriver,
  type TransactionOptions,
  type TransitionRecord,
  type VersionToken,
} from "@interlock/core";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Transaction } from "../db.js";

interface TransitionRow {
  id: string;
  lifecycle: string;
  resource_type: string;
  resource_id: string;
  event: string;
  from_state: string;
  to_state: string;
  previous_version: bigint;
  next_version: bigint;
  actor_type: string | null;
  actor_id: string | null;
  audit_data: unknown;
  metadata: unknown;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  definition_version: string | null;
  occurred_at: Date;
}

function version(value: bigint): VersionToken {
  const parsed = parseVersionToken(String(value));
  if (!parsed.success)
    throw new InterlockError(
      "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
      "Prisma returned an invalid transition version.",
    );
  return parsed.value;
}

function transition(row: TransitionRow): TransitionRecord {
  return {
    id: row.id,
    lifecycle: row.lifecycle,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    event: row.event,
    fromState: row.from_state,
    toState: row.to_state,
    previousVersion: version(row.previous_version),
    nextVersion: version(row.next_version),
    occurredAt: new Date(row.occurred_at.getTime()),
    ...(row.actor_type === null ? {} : { actorType: row.actor_type }),
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    ...(row.audit_data === null
      ? {}
      : { auditData: JSON.parse(JSON.stringify(row.audit_data)) }),
    ...(row.metadata === null
      ? {}
      : { metadata: JSON.parse(JSON.stringify(row.metadata)) }),
    ...(row.correlation_id === null
      ? {}
      : { correlationId: row.correlation_id }),
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    ...(row.idempotency_key === null
      ? {}
      : { idempotencyKey: row.idempotency_key }),
    ...(row.request_fingerprint === null
      ? {}
      : { requestFingerprint: row.request_fingerprint }),
    ...(row.definition_version === null
      ? {}
      : { definitionVersion: row.definition_version }),
  };
}

export class PrismaInterlockDriver implements TransactionDriver<Transaction> {
  constructor(private readonly prisma: PrismaClient) {}

  transaction<Result>(
    operation: (transaction: Transaction) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    const levels = {
      "read-committed": Prisma.TransactionIsolationLevel.ReadCommitted,
      "repeatable-read": Prisma.TransactionIsolationLevel.RepeatableRead,
      serializable: Prisma.TransactionIsolationLevel.Serializable,
    } as const;
    return this.prisma.$transaction(
      async (transaction) => {
        if (options.readOnly)
          await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return operation(transaction);
      },
      { isolationLevel: levels[options.isolation ?? "read-committed"] },
    );
  }

  async claimIdempotency(
    transaction: Transaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult> {
    const inserted = await transaction.$executeRaw`
      INSERT INTO interlock.interlock_idempotency
        (lifecycle, resource_id, idempotency_key, fingerprint, created_at)
      VALUES (${claim.lifecycle}, ${claim.resourceId}, ${claim.key}, ${claim.fingerprint}, ${claim.createdAt})
      ON CONFLICT DO NOTHING
    `;
    if (inserted === 1) return { status: "claimed" };
    const rows = await transaction.$queryRaw<
      Array<TransitionRow & { fingerprint: string }>
    >`
      SELECT i.fingerprint, h.*
      FROM interlock.interlock_idempotency i
      LEFT JOIN interlock.interlock_transition_history h ON h.id = i.transition_id
      WHERE i.lifecycle = ${claim.lifecycle}
        AND i.resource_id = ${claim.resourceId}
        AND i.idempotency_key = ${claim.key}
    `;
    const row = rows[0];
    if (!row || row.fingerprint !== claim.fingerprint)
      return { status: "conflict" };
    if (!row.id)
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Prisma returned an incomplete duplicate claim.",
      );
    return { status: "duplicate", transition: transition(row) };
  }

  async completeIdempotency(
    transaction: Transaction,
    completion: {
      lifecycle: string;
      resourceId: string;
      key: string;
      transitionId: string;
      completedAt: Date;
    },
  ) {
    const count = await transaction.$executeRaw`
      UPDATE interlock.interlock_idempotency
      SET transition_id = ${completion.transitionId}, completed_at = ${completion.completedAt}
      WHERE lifecycle = ${completion.lifecycle}
        AND resource_id = ${completion.resourceId}
        AND idempotency_key = ${completion.key}
        AND transition_id IS NULL
    `;
    if (count !== 1)
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Prisma idempotency completion affected an unexpected row count.",
      );
  }

  async insertTransition(transaction: Transaction, value: TransitionRecord) {
    await transaction.$executeRaw`
      INSERT INTO interlock.interlock_transition_history
        (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,actor_type,actor_id,audit_data,metadata,correlation_id,causation_id,idempotency_key,request_fingerprint,definition_version,occurred_at)
      VALUES (${value.id},${value.lifecycle},${value.resourceType},${value.resourceId},${value.event},${value.fromState},${value.toState},${value.previousVersion}::bigint,${value.nextVersion}::bigint,${value.actorType ?? null},${value.actorId ?? null},${value.auditData === undefined ? null : JSON.stringify(value.auditData)}::jsonb,${value.metadata === undefined ? null : JSON.stringify(value.metadata)}::jsonb,${value.correlationId ?? null},${value.causationId ?? null},${value.idempotencyKey ?? null},${value.requestFingerprint ?? null},${value.definitionVersion ?? null},${value.occurredAt})
    `;
  }

  async insertOutbox(
    transaction: Transaction,
    messages: readonly OutboxInsert[],
  ) {
    for (const message of messages)
      await transaction.$executeRaw`
        INSERT INTO interlock.interlock_outbox
          (id,lifecycle,resource_type,resource_id,transition_id,topic,message_key,payload,created_at)
        VALUES (${message.id},${message.lifecycle},${message.resourceType},${message.resourceId},${message.transitionId},${message.topic},${message.key ?? null},${JSON.stringify(message.payload)}::jsonb,${message.createdAt})
      `;
  }
}
