import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalHash,
  createInterlock,
  defineLifecycle,
  noInput,
  type IdempotencyClaim,
  type IdempotencyClaimResult,
  type OutboxInsert,
  type ResourceBinding,
  type TransactionDriver,
  type TransactionOptions,
  type TransitionRecord,
  type VersionToken,
} from "@interlock/core";
import { Prisma, PrismaClient } from "@prisma/client";

type Transaction = Prisma.TransactionClient;
type Resource = {
  id: string;
  state: string;
  version: VersionToken;
};

const lifecycle = defineLifecycle<Resource, undefined, object, object>()({
  name: "prisma-spike",
  states: ["review", "approved"],
  history: { resourceType: "application" },
  idempotency: {
    fingerprint: ({ resourceId, event, expectedVersion }) =>
      canonicalHash({ resourceId, event, expectedVersion }),
  },
  events: {
    approve: {
      from: ["review"],
      to: "approved",
      input: noInput,
      mutate: () => ({}),
      outbox: ({ resource }) => [
        { topic: "approved", payload: { id: resource.id } },
      ],
    },
  },
});

const rowToTransition = (row: Record<string, unknown>): TransitionRecord => ({
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
});

class PrismaDriver implements TransactionDriver<Transaction> {
  readonly pids: number[] = [];
  constructor(private readonly prisma: PrismaClient) {}

  private async mark(transaction: Transaction) {
    const rows = await transaction.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid() pid
    `;
    this.pids.push(Number(rows[0]?.pid));
  }

  transaction<Result>(
    operation: (transaction: Transaction) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    if (options.readOnly)
      throw new Error("The Prisma spike does not advertise read-only support.");
    const isolationLevels = {
      "read-committed": "ReadCommitted",
      "repeatable-read": "RepeatableRead",
      serializable: "Serializable",
    } as const satisfies Record<
      NonNullable<TransactionOptions["isolation"]>,
      Prisma.TransactionIsolationLevel
    >;
    const isolationLevel =
      isolationLevels[options.isolation ?? "read-committed"];
    return this.prisma.$transaction(operation, { isolationLevel });
  }

  async claimIdempotency(
    transaction: Transaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult> {
    await this.mark(transaction);
    const inserted = await transaction.$executeRaw`
      INSERT INTO interlock_idempotency
        (lifecycle, resource_id, idempotency_key, fingerprint, created_at)
      VALUES
        (${claim.lifecycle}, ${claim.resourceId}, ${claim.key}, ${claim.fingerprint}, ${claim.createdAt})
      ON CONFLICT DO NOTHING
    `;
    if (inserted === 1) return { status: "claimed" };
    const rows = await transaction.$queryRaw<Array<Record<string, unknown>>>`
        SELECT i.fingerprint, h.*
        FROM interlock_idempotency i
        LEFT JOIN interlock_transition_history h ON h.id = i.transition_id
        WHERE i.lifecycle = ${claim.lifecycle}
          AND i.resource_id = ${claim.resourceId}
          AND i.idempotency_key = ${claim.key}
      `;
    const row = rows[0];
    if (!row || row.fingerprint !== claim.fingerprint)
      return { status: "conflict" };
    return { status: "duplicate", transition: rowToTransition(row) };
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
    await this.mark(transaction);
    const count = await transaction.$executeRaw`
      UPDATE interlock_idempotency
      SET transition_id = ${completion.transitionId}, completed_at = ${completion.completedAt}
      WHERE lifecycle = ${completion.lifecycle}
        AND resource_id = ${completion.resourceId}
        AND idempotency_key = ${completion.key}
        AND transition_id IS NULL
    `;
    assert.equal(count, 1);
  }

  async insertTransition(
    transaction: Transaction,
    value: TransitionRecord,
  ): Promise<TransitionRecord> {
    await this.mark(transaction);
    await transaction.$executeRaw`
      INSERT INTO interlock_transition_history
        (id,lifecycle,resource_type,resource_id,event,from_state,to_state,previous_version,next_version,occurred_at)
      VALUES
        (${value.id},${value.lifecycle},${value.resourceType},${value.resourceId},${value.event},${value.fromState},${value.toState},${value.previousVersion}::bigint,${value.nextVersion}::bigint,${value.occurredAt})
    `;
    return value;
  }

  async insertOutbox(
    transaction: Transaction,
    messages: readonly OutboxInsert[],
  ) {
    await this.mark(transaction);
    for (const message of messages)
      await transaction.$executeRaw`
        INSERT INTO interlock_outbox
          (id,lifecycle,resource_type,resource_id,transition_id,topic,message_key,payload,created_at)
        VALUES
          (${message.id},${message.lifecycle},${message.resourceType},${message.resourceId},${message.transitionId},${message.topic},${message.key ?? null},${JSON.stringify(message.payload)}::jsonb,${message.createdAt})
      `;
  }
}

const pids: number[] = [];
const binding: ResourceBinding<Transaction, Resource, object, object> = {
  transactionOptions: () => ({ isolation: "read-committed" }),
  loadPrimary: async (transaction, id) => {
    const pid = await transaction.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid() pid
    `;
    pids.push(Number(pid[0]?.pid));
    const row = await transaction.spikeApplication.findUnique({
      where: { id },
    });
    return row
      ? {
          id: row.id,
          state: row.state,
          version: String(row.version) as VersionToken,
        }
      : null;
  },
  getId: (resource) => resource.id,
  getState: (resource) => resource.state,
  getVersion: (resource) => resource.version,
  applyPrimary: async (transaction, args) => {
    const pid = await transaction.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid() pid
    `;
    pids.push(Number(pid[0]?.pid));
    const count = await transaction.spikeApplication.updateMany({
      where: {
        id: args.resource.id,
        state: args.fromState,
        version: BigInt(args.expectedVersion),
      },
      data: { state: args.toState, version: BigInt(args.nextVersion) },
    });
    if (count.count !== 1) return { status: "conflict" };
    const row = await transaction.spikeApplication.findUniqueOrThrow({
      where: { id: args.resource.id },
    });
    return {
      status: "applied",
      resource: {
        id: row.id,
        state: row.state,
        version: String(row.version) as VersionToken,
      },
    };
  },
  contextFactory: { create: () => ({}) },
  consistency: () => ({ strategy: "none", notes: "No related data." }),
};

const prisma = new PrismaClient();
const id = randomUUID();
try {
  const migration = await readFile(
    new URL(
      "../../packages/postgres/migrations/001_interlock.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of migration
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean))
    await prisma.$executeRawUnsafe(statement);
  await prisma.$executeRawUnsafe(
    "CREATE TABLE IF NOT EXISTS spike_applications (id TEXT PRIMARY KEY, state TEXT NOT NULL, version BIGINT NOT NULL CHECK (version >= 1))",
  );
  await prisma.spikeApplication.create({
    data: { id, state: "review", version: 1n },
  });
  const driver = new PrismaDriver(prisma);
  const interlock = createInterlock({ lifecycle, driver, binding });
  const result = await interlock.transition({
    id,
    event: "approve",
    actor: undefined,
    expectedVersion: "1",
    idempotency: { key: randomUUID() },
  });
  assert.equal(result.status, "committed");
  assert.equal(new Set([...pids, ...driver.pids]).size, 1);
} finally {
  await prisma.$disconnect();
}
