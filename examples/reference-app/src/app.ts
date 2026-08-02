import { isInterlockError, type TransitionResult } from "@interlock/core";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";
import {
  createPermitService,
  type CommandOptions,
} from "./domain/permits/service.js";
import type { PermitResource } from "./domain/permits/types.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function permitJson(row: {
  id: string;
  tenantId: string;
  permitNumber: number;
  state: string;
  version: bigint;
  applicantName: string;
  applicantUserId: string;
}) {
  return { ...row, version: String(row.version) };
}

function sendResult(
  reply: FastifyReply,
  result: TransitionResult<PermitResource>,
) {
  switch (result.status) {
    case "committed":
      return reply.code(200).send({
        status: "committed",
        duplicate: result.duplicate,
        transition: result.transition,
        ...(result.duplicate ? {} : { resource: result.resource }),
      });
    case "denied":
      return reply.code(403).send(result);
    case "invalid-input":
    case "unknown-event":
      return reply.code(400).send(result);
    case "conflict":
    case "idempotency-conflict":
      return reply.code(409).send(result);
    case "not-found":
      return reply.code(404).send(result);
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

async function command(
  request: FastifyRequest,
  reply: FastifyReply,
  database: Database,
): Promise<CommandOptions | undefined> {
  const actor = await authenticate(database, request);
  if (!actor) {
    await reply.code(401).send({ error: "UNAUTHORIZED" });
    return undefined;
  }
  const expectedVersion = request.headers["expected-version"];
  const idempotencyKey = request.headers["idempotency-key"];
  const id = (request.params as { id?: unknown }).id;
  if (
    typeof id !== "string" ||
    typeof expectedVersion !== "string" ||
    typeof idempotencyKey !== "string" ||
    !idempotencyKey
  ) {
    await reply
      .code(400)
      .send({ error: "EXPECTED_VERSION_AND_IDEMPOTENCY_KEY_REQUIRED" });
    return undefined;
  }
  return {
    id,
    actor,
    expectedVersion,
    idempotencyKey,
    correlationId: request.id,
  };
}

export function createApp(
  database: Database,
  options: { logger?: boolean; bodyLimit?: number } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 65_536,
    requestTimeout: 15_000,
    connectionTimeout: 5_000,
    keepAliveTimeout: 5_000,
  });
  const service = createPermitService(database);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (isInterlockError(error))
      return reply
        .code(500)
        .send({ error: error.code, message: error.message });
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.post("/permits", async (request, reply) => {
    const actor = await authenticate(database, request);
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const body = object(request.body);
    if (
      typeof body.permitNumber !== "number" ||
      typeof body.applicantName !== "string"
    )
      return reply.code(400).send({ error: "INVALID_PERMIT" });
    const permit = await service.create(actor, {
      permitNumber: body.permitNumber,
      applicantName: body.applicantName,
    });
    return reply.code(201).send(permitJson(permit));
  });

  app.get("/permits/:id", async (request, reply) => {
    const actor = await authenticate(database, request);
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const id = (request.params as { id: string }).id;
    const permit = await database.permit.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    return permit
      ? permitJson(permit)
      : reply.code(404).send({ error: "NOT_FOUND" });
  });

  const eventRoute = (
    name: string,
    run: (
      options: CommandOptions,
      input: Record<string, unknown>,
    ) => Promise<TransitionResult<PermitResource>>,
  ) => {
    app.post(`/permits/:id/events/${name}`, async (request, reply) => {
      const options = await command(request, reply, database);
      if (!options) return;
      return sendResult(reply, await run(options, object(request.body)));
    });
  };
  eventRoute("submit", (options, input) =>
    service.submit(
      options,
      typeof input.note === "string" ? { note: input.note } : {},
    ),
  );
  eventRoute("beginReview", (options, input) =>
    service.beginReview(options, {
      reviewerId: typeof input.reviewerId === "string" ? input.reviewerId : "",
    }),
  );
  eventRoute("approve", (options, input) =>
    service.approve(
      options,
      typeof input.note === "string" ? { note: input.note } : {},
    ),
  );
  eventRoute("reject", (options, input) =>
    service.reject(options, {
      reason: typeof input.reason === "string" ? input.reason : "",
    }),
  );
  eventRoute("cancel", (options, input) =>
    service.cancel(
      options,
      typeof input.reason === "string" ? { reason: input.reason } : {},
    ),
  );

  app.get("/permits/:id/history", async (request, reply) => {
    const actor = await authenticate(database, request);
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const id = (request.params as { id: string }).id;
    const visible = await database.permit.count({
      where: { id, tenantId: actor.tenantId },
    });
    if (!visible) return reply.code(404).send({ error: "NOT_FOUND" });
    const rows = await database.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM interlock.interlock_transition_history
      WHERE lifecycle = 'permit' AND resource_id = ${id}
      ORDER BY next_version
    `;
    return rows;
  });

  app.get("/outbox", async (request, reply) => {
    const actor = await authenticate(database, request);
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED" });
    return database.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM interlock.interlock_outbox
      WHERE payload->>'tenantId' = ${actor.tenantId}
      ORDER BY created_at
    `;
  });

  return app;
}
