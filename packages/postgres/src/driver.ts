import {
  InterlockError,
  isInterlockError,
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

const OUTBOX_BATCH_SIZE = 500;

export interface PostgresDriverOptions {
  schema?: string;
}

function quotedIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 63
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "PostgreSQL schema must be a non-empty identifier of at most 63 bytes without null characters.",
    );
  return `"${value.replaceAll('"', '""')}"`;
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

function failureChain(error: unknown): PgFailure[] {
  const failures: PgFailure[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (
    current &&
    (typeof current === "object" || typeof current === "function") &&
    !seen.has(current)
  ) {
    seen.add(current);
    failures.push(current as PgFailure);
    current = (current as { cause?: unknown }).cause;
  }
  return failures;
}

function connectionFailure(error: unknown): Error | undefined {
  return failureChain(error).find(
    (failure) =>
      failure instanceof Error &&
      (failure.code?.startsWith("08") ||
        /connection (?:terminated|lost|closed)/i.test(failure.message)),
  );
}

export function normalizePostgresError(
  error: unknown,
  duringCommit = false,
): InterlockError {
  const failures = failureChain(error);
  const failure = failures[0];
  const connection = failures.find(
    (candidate) =>
      candidate.code?.startsWith("08") || candidate.code === "57P01",
  );
  if (
    duringCommit &&
    (connection || (!isInterlockError(error) && !failure?.code))
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
  const mappedFailure = failures.find(
    (candidate) => candidate.code && codes[candidate.code],
  );
  const mapped = mappedFailure?.code ? codes[mappedFailure.code] : undefined;
  if (mapped) return new InterlockError(mapped[0], mapped[1], { cause: error });
  if (isInterlockError(error)) return error;
  return new InterlockError(
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
    occurredAt:
      row.occurred_at instanceof Date
        ? new Date(row.occurred_at.getTime())
        : new Date(String(row.occurred_at)),
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
  private readonly tables: {
    history: string;
    idempotency: string;
    outbox: string;
  };

  constructor(
    private readonly pool: Pool,
    options: PostgresDriverOptions = {},
  ) {
    if (!options || typeof options !== "object")
      throw new InterlockError(
        "INTERLOCK_DEFINITION_INVALID",
        "PostgreSQL driver options must be an object.",
      );
    const schema = quotedIdentifier(options.schema ?? "public");
    this.tables = Object.freeze({
      history: `${schema}."interlock_transition_history"`,
      idempotency: `${schema}."interlock_idempotency"`,
      outbox: `${schema}."interlock_outbox"`,
    });
  }

  async transaction<Result>(
    operation: (transaction: PgTransaction) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw normalizePostgresError(error);
    }
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
      try {
        client.release(releaseFailure ?? emittedFailure);
      } catch {
        /* Pool cleanup must not replace the transaction outcome. */
      }
      try {
        client.off("error", captureFailure);
      } catch {
        /* Listener cleanup must not replace the transaction outcome. */
      }
    }
  }

  async claimIdempotency(
    transaction: PgTransaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult> {
    const inserted = await transaction.query(
      `INSERT INTO ${this.tables.idempotency} (lifecycle, resource_id, idempotency_key, fingerprint, created_at)
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
      `SELECT i.fingerprint, h.* FROM ${this.tables.idempotency} i
       LEFT JOIN ${this.tables.history} h ON h.id = i.transition_id
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
      `UPDATE ${this.tables.idempotency} SET transition_id = $4, completed_at = $5
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
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO ${this.tables.history}
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
  }

  async insertOutbox(
    transaction: PgTransaction,
    messages: readonly OutboxInsert[],
  ): Promise<void> {
    for (
      let offset = 0;
      offset < messages.length;
      offset += OUTBOX_BATCH_SIZE
    ) {
      const batch = messages.slice(offset, offset + OUTBOX_BATCH_SIZE);
      const values: unknown[] = [];
      const rows: string[] = [];
      for (const message of batch) {
        const parameter = values.length;
        rows.push(
          `($${parameter + 1},$${parameter + 2},$${parameter + 3},$${parameter + 4},$${parameter + 5},$${parameter + 6},$${parameter + 7},$${parameter + 8},$${parameter + 9})`,
        );
        values.push(
          message.id,
          message.lifecycle,
          message.resourceType,
          message.resourceId,
          message.transitionId,
          message.topic,
          message.key ?? null,
          message.payload,
          message.createdAt,
        );
      }
      const result = await transaction.query(
        `INSERT INTO ${this.tables.outbox} (id, lifecycle, resource_type, resource_id, transition_id, topic, message_key, payload, created_at)
         VALUES ${rows.join(",")}`,
        values,
      );
      if (result.rowCount !== batch.length)
        throw new InterlockError(
          "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
          "Outbox insertion affected an unexpected row count.",
        );
    }
  }
}
