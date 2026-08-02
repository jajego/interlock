import {
  InterlockError,
  type IdempotencyClaim,
  type IdempotencyClaimResult,
  type OutboxInsert,
  type JsonValue,
  type TransactionDriver,
  type TransactionOptions,
  type TransitionRecord,
  type VersionToken,
} from "@interlock/core";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export interface PgTransaction {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

class ScopedTransaction implements PgTransaction {
  active = true;
  constructor(private readonly client: PoolClient) {}
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    if (!this.active)
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Transaction handle used after completion.",
      );
    return this.client.query<Row>(text, values ? [...values] : undefined);
  }
}

interface PgFailure extends Error {
  code?: string;
}

function connectionFailure(error: unknown): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  const failure = error as PgFailure;
  if (
    failure.code?.startsWith("08") ||
    /connection (?:terminated|lost|closed)/i.test(error.message)
  )
    return error;
  return connectionFailure(error.cause);
}

export function normalizePostgresError(
  error: unknown,
  duringCommit = false,
): InterlockError {
  if (error instanceof InterlockError) return error;
  const failure = error as PgFailure;
  if (
    duringCommit &&
    (!failure.code || failure.code.startsWith("08") || failure.code === "57P01")
  ) {
    return new InterlockError(
      "INTERLOCK_COMMIT_OUTCOME_UNKNOWN",
      "PostgreSQL commit outcome is unknown.",
      { cause: error },
    );
  }
  const codes: Record<
    string,
    [ConstructorParameters<typeof InterlockError>[0], string]
  > = {
    "40001": [
      "INTERLOCK_SERIALIZATION_CONFLICT",
      "PostgreSQL serialization conflict.",
    ],
    "40P01": ["INTERLOCK_DEADLOCK", "PostgreSQL deadlock."],
    "55P03": ["INTERLOCK_LOCK_TIMEOUT", "PostgreSQL lock timeout."],
    "57014": ["INTERLOCK_CANCELLED", "PostgreSQL operation cancelled."],
  };
  const mapped = failure.code ? codes[failure.code] : undefined;
  return mapped
    ? new InterlockError(mapped[0], mapped[1], { cause: error })
    : new InterlockError(
        "INTERLOCK_TRANSACTION_FAILED",
        "PostgreSQL transaction failed.",
        { cause: error },
      );
}

function beginSql(options: TransactionOptions): string {
  const isolation = options.isolation ?? "read-committed";
  const levels = {
    "read-committed": "READ COMMITTED",
    "repeatable-read": "REPEATABLE READ",
    serializable: "SERIALIZABLE",
  } as const;
  return `BEGIN ISOLATION LEVEL ${levels[isolation]} READ ${options.readOnly ? "ONLY" : "WRITE"}`;
}

function rowToTransition(row: Record<string, unknown>): TransitionRecord {
  return {
    id: String(row.id),
    lifecycle: String(row.lifecycle),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    event: String(row.event),
    fromState: String(row.from_state),
    toState: String(row.to_state),
    previousVersion: String(row.previous_version) as VersionToken,
    nextVersion: String(row.next_version) as VersionToken,
    occurredAt: new Date(String(row.occurred_at)),
    ...(row.actor_type == null ? {} : { actorType: String(row.actor_type) }),
    ...(row.actor_id == null ? {} : { actorId: String(row.actor_id) }),
    ...(row.audit_data == null
      ? {}
      : { auditData: row.audit_data as JsonValue }),
    ...(row.metadata == null ? {} : { metadata: row.metadata as JsonValue }),
    ...(row.correlation_id == null
      ? {}
      : { correlationId: String(row.correlation_id) }),
    ...(row.causation_id == null
      ? {}
      : { causationId: String(row.causation_id) }),
    ...(row.idempotency_key == null
      ? {}
      : { idempotencyKey: String(row.idempotency_key) }),
    ...(row.request_fingerprint == null
      ? {}
      : { requestFingerprint: String(row.request_fingerprint) }),
    ...(row.definition_version == null
      ? {}
      : { definitionVersion: String(row.definition_version) }),
  };
}

export class PostgresDriver implements TransactionDriver<PgTransaction> {
  constructor(private readonly pool: Pool) {}

  async transaction<Result>(
    operation: (transaction: PgTransaction) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    const client = await this.pool.connect();
    let emittedFailure: Error | undefined;
    const captureFailure = (error: Error) => {
      emittedFailure = error;
    };
    client.on("error", captureFailure);
    const transaction = new ScopedTransaction(client);
    let committing = false;
    let releaseFailure: Error | undefined;
    try {
      await client.query(beginSql(options));
      const result = await operation(transaction);
      transaction.active = false;
      committing = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      releaseFailure = connectionFailure(error);
      transaction.active = false;
      if (!committing) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* Original failure determines the public outcome. */
        }
        if (!(error instanceof Error)) throw error;
      }
      throw normalizePostgresError(error, committing);
    } finally {
      client.release(releaseFailure ?? emittedFailure);
      client.off("error", captureFailure);
    }
  }

  async claimIdempotency(
    transaction: PgTransaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult> {
    const inserted = await transaction.query(
      `INSERT INTO interlock_idempotency (lifecycle, resource_id, idempotency_key, fingerprint, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING fingerprint`,
      [
        claim.lifecycle,
        claim.resourceId,
        claim.key,
        claim.fingerprint,
        claim.createdAt,
      ],
    );
    if (inserted.rowCount === 1) return { status: "claimed" };
    const existing = await transaction.query(
      `SELECT i.fingerprint, h.* FROM interlock_idempotency i
       LEFT JOIN interlock_transition_history h ON h.id = i.transition_id
       WHERE i.lifecycle = $1 AND i.resource_id = $2 AND i.idempotency_key = $3`,
      [claim.lifecycle, claim.resourceId, claim.key],
    );
    const row = existing.rows[0];
    if (!row || row.fingerprint !== claim.fingerprint)
      return { status: "conflict" };
    if (!row.id)
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Committed idempotency claim is incomplete.",
      );
    return { status: "duplicate", transition: rowToTransition(row) };
  }

  async completeIdempotency(
    transaction: PgTransaction,
    completion: {
      lifecycle: string;
      resourceId: string;
      key: string;
      transitionId: string;
      completedAt: Date;
    },
  ): Promise<void> {
    const result = await transaction.query(
      `UPDATE interlock_idempotency SET transition_id = $4, completed_at = $5
       WHERE lifecycle = $1 AND resource_id = $2 AND idempotency_key = $3 AND transition_id IS NULL`,
      [
        completion.lifecycle,
        completion.resourceId,
        completion.key,
        completion.transitionId,
        completion.completedAt,
      ],
    );
    if (result.rowCount !== 1)
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Idempotency completion affected an unexpected row count.",
      );
  }

  async insertTransition(
    transaction: PgTransaction,
    value: TransitionRecord,
  ): Promise<TransitionRecord> {
    await transaction.query(
      `INSERT INTO interlock_transition_history
       (id, lifecycle, resource_type, resource_id, event, from_state, to_state, previous_version, next_version, actor_type, actor_id, audit_data, metadata, correlation_id, causation_id, idempotency_key, request_fingerprint, definition_version, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        value.id,
        value.lifecycle,
        value.resourceType,
        value.resourceId,
        value.event,
        value.fromState,
        value.toState,
        value.previousVersion,
        value.nextVersion,
        value.actorType ?? null,
        value.actorId ?? null,
        value.auditData ?? null,
        value.metadata ?? null,
        value.correlationId ?? null,
        value.causationId ?? null,
        value.idempotencyKey ?? null,
        value.requestFingerprint ?? null,
        value.definitionVersion ?? null,
        value.occurredAt,
      ],
    );
    return value;
  }

  async insertOutbox(
    transaction: PgTransaction,
    messages: readonly OutboxInsert[],
  ): Promise<void> {
    for (const message of messages) {
      await transaction.query(
        `INSERT INTO interlock_outbox (id, lifecycle, resource_type, resource_id, transition_id, topic, message_key, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          message.id,
          message.lifecycle,
          message.resourceType,
          message.resourceId,
          message.transitionId,
          message.topic,
          message.key ?? null,
          message.payload,
          message.createdAt,
        ],
      );
    }
  }
}
