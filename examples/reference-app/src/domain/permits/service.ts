import { createInterlock, type ClientFor } from "@interlock/core";
import { randomUUID } from "node:crypto";
import type {
  Database,
  StatementObserver,
  TransactionTiming,
} from "../../db.js";
import { PrismaInterlockDriver } from "../../interlock/prisma-driver.js";
import { createPermitBinding } from "./binding.js";
import { permitLifecycle } from "./lifecycle.js";
import type { PermitActor } from "./types.js";

export interface CommandOptions {
  id: string;
  actor: PermitActor;
  expectedVersion: string;
  idempotencyKey: string;
  correlationId?: string;
}

export function createPermitService(
  database: Database,
  options: {
    observeStatement?: StatementObserver;
    observeTransaction?(timing: TransactionTiming): void;
  } = {},
) {
  const observe = options.observeStatement;
  const client: ClientFor<typeof permitLifecycle> = createInterlock({
    lifecycle: permitLifecycle,
    binding: createPermitBinding(observe),
    driver: new PrismaInterlockDriver(database, {
      ...(observe ? { observeStatement: observe } : {}),
      ...(options.observeTransaction
        ? { observeTransaction: options.observeTransaction }
        : {}),
    }),
  });
  const common = (options: CommandOptions) => ({
    id: options.id,
    actor: options.actor,
    expectedVersion: options.expectedVersion,
    idempotency: { key: options.idempotencyKey },
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
  });
  return {
    client,
    create: (
      actor: PermitActor,
      input: { permitNumber: number; applicantName: string },
    ) => {
      observe?.("permit-create");
      return database.permit.create({
        data: {
          id: randomUUID(),
          tenantId: actor.tenantId,
          permitNumber: input.permitNumber,
          applicantName: input.applicantName,
          applicantUserId: actor.id,
          state: "draft",
        },
      });
    },
    submit: (options: CommandOptions, input: { note?: string }) =>
      client.transition({ ...common(options), event: "submit", input }),
    beginReview: (options: CommandOptions, input: { reviewerId: string }) =>
      client.transition({ ...common(options), event: "beginReview", input }),
    approve: (options: CommandOptions, input: { note?: string }) =>
      client.transition({ ...common(options), event: "approve", input }),
    reject: (options: CommandOptions, input: { reason: string }) =>
      client.transition({ ...common(options), event: "reject", input }),
    cancel: (options: CommandOptions, input: { reason?: string }) =>
      client.transition({ ...common(options), event: "cancel", input }),
  };
}
