import { randomUUID } from "node:crypto";
import { InterlockError } from "./errors.js";
import { assertJsonValue } from "./json.js";
import type { EventMap, Lifecycle } from "./lifecycle.js";
import type {
  AssessmentResult,
  Denial,
  JsonValue,
  ResourceBinding,
  TransactionDriver,
  TransitionResult,
  VersionExpectation,
  VersionToken,
} from "./types.js";
import { incrementVersion, parseVersionToken } from "./version.js";

export interface TransitionRequest<Actor> {
  id: string;
  event: string;
  input?: unknown;
  actor: Actor;
  expectedVersion: unknown;
  idempotency?: { key: string };
  metadata?: JsonValue;
  correlationId?: string;
  causationId?: string;
}

class RollbackOutcome<Resource> {
  constructor(readonly result: TransitionResult<Resource>) {}
}

function rollback<Resource>(result: TransitionResult<Resource>): never {
  throw new RollbackOutcome(result);
}

export function createInterlock<
  Transaction,
  Resource,
  Actor,
  Context,
  Mutation,
  Events extends EventMap<Resource, Actor, Context, Mutation>,
>(options: {
  lifecycle: Lifecycle<Resource, Actor, Context, Mutation, Events>;
  driver: TransactionDriver<Transaction>;
  binding: ResourceBinding<Transaction, Resource, Mutation, Context>;
  ids?: () => string;
  now?: () => Date;
  maxOutboxPayloadBytes?: number;
}) {
  const { lifecycle, driver, binding } = options;
  const ids = options.ids ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const maxOutboxPayloadBytes = options.maxOutboxPayloadBytes ?? 256_000;

  async function normalize(request: TransitionRequest<Actor>) {
    const event = lifecycle.getEvent(request.event);
    if (!event)
      return {
        result: { status: "unknown-event", event: request.event } as const,
      };
    const parsed = await lifecycle.parseInput(event, request.input);
    if (!parsed.success)
      return {
        result: { status: "invalid-input", issues: parsed.issues } as const,
      };
    let expectedVersion: VersionExpectation;
    if (request.expectedVersion === "use-loaded-version")
      expectedVersion = request.expectedVersion;
    else {
      const parsedVersion = parseVersionToken(request.expectedVersion);
      if (!parsedVersion.success)
        return {
          result: {
            status: "invalid-input",
            issues: [parsedVersion.issue],
          } as const,
        };
      expectedVersion = parsedVersion.value;
    }
    const fingerprint = request.idempotency
      ? lifecycle.idempotency?.fingerprint({
          lifecycle: lifecycle.name,
          resourceId: request.id,
          event: request.event,
          parsedInput: parsed.value,
          actor: request.actor,
          expectedVersion,
        })
      : undefined;
    if (request.idempotency && !fingerprint)
      throw new InterlockError(
        "INTERLOCK_DEFINITION_INVALID",
        "Idempotency requires a fingerprint projection.",
      );
    return { event, input: parsed.value, expectedVersion, fingerprint };
  }

  async function evaluate(
    event: Events[keyof Events],
    resource: Resource,
    actor: Actor,
    context: Context,
    input: unknown,
  ): Promise<Denial | undefined> {
    const state = binding.getState(resource);
    if (!event.from.includes(state))
      return { source: "state", code: "INVALID_SOURCE_STATE" };
    const args = { resource, actor, context, input };
    const authorization = await event.authorize?.(args);
    if (authorization && !authorization.allowed)
      return { ...authorization.denial, source: "authorization" };
    for (const guard of event.guards ?? []) {
      const decision = await guard.evaluate(args);
      if (!decision.allowed)
        return { ...decision.denial, source: "guard", rule: guard.name };
    }
    return undefined;
  }

  async function assess(
    request: TransitionRequest<Actor>,
  ): Promise<AssessmentResult> {
    const normalized = await normalize(request);
    if ("result" in normalized) return normalized.result;
    return driver.transaction(
      async (transaction) => {
        const resource = await binding.loadPrimary(transaction, request.id);
        if (!resource) return { status: "not-found" };
        const context = binding.contextFactory.create(transaction, {
          mode: "advisory",
          event: request.event,
        });
        const reason = await evaluate(
          normalized.event,
          resource,
          request.actor,
          context,
          normalized.input,
        );
        return reason
          ? {
              status: "denied",
              event: request.event,
              currentState: binding.getState(resource),
              targetState: normalized.event.to,
              reasons: [reason],
            }
          : {
              status: "allowed",
              currentState: binding.getState(resource),
              targetState: normalized.event.to,
            };
      },
      binding.transactionOptions({ mode: "advisory", event: request.event }),
    );
  }

  async function transition(
    request: TransitionRequest<Actor>,
  ): Promise<TransitionResult<Resource>> {
    const normalized = await normalize(request);
    if ("result" in normalized) return normalized.result;
    try {
      return await driver.transaction(
        async (transaction) => {
          const occurredAt = now();
          if (request.idempotency) {
            const claim = await driver.claimIdempotency(transaction, {
              lifecycle: lifecycle.name,
              resourceId: request.id,
              key: request.idempotency.key,
              fingerprint: normalized.fingerprint!,
              createdAt: occurredAt,
            });
            if (claim.status === "conflict")
              return {
                status: "idempotency-conflict",
                key: request.idempotency.key,
              };
            if (claim.status === "duplicate")
              return {
                status: "committed",
                duplicate: true,
                transition: claim.transition,
              };
          }
          const resource = await binding.loadPrimary(transaction, request.id);
          if (!resource) rollback({ status: "not-found" });
          const loadedVersion = binding.getVersion(resource);
          if (
            normalized.expectedVersion !== "use-loaded-version" &&
            normalized.expectedVersion !== loadedVersion
          ) {
            rollback({
              status: "conflict",
              expected: normalized.expectedVersion,
              actual: {
                state: binding.getState(resource),
                version: loadedVersion,
              },
            });
          }
          const expectedVersion: VersionToken =
            normalized.expectedVersion === "use-loaded-version"
              ? loadedVersion
              : normalized.expectedVersion;
          const context = binding.contextFactory.create(transaction, {
            mode: "authoritative",
            event: request.event,
          });
          const reason = await evaluate(
            normalized.event,
            resource,
            request.actor,
            context,
            normalized.input,
          );
          if (reason)
            rollback({
              status: "denied",
              event: request.event,
              currentState: binding.getState(resource),
              targetState: normalized.event.to,
              reasons: [reason],
            });

          const transitionId = ids();
          const projection = {
            resource,
            actor: request.actor,
            context,
            input: normalized.input,
            transitionId,
            clock: { occurredAt },
          };
          const mutation = normalized.event.mutate(projection);
          const auditData = normalized.event.audit?.(projection);
          const descriptors = normalized.event.outbox?.(projection) ?? [];
          if (auditData !== undefined) assertJsonValue(auditData);
          for (const descriptor of descriptors) {
            assertJsonValue(descriptor.payload);
            if (
              Buffer.byteLength(JSON.stringify(descriptor.payload)) >
              maxOutboxPayloadBytes
            )
              throw new InterlockError(
                "INTERLOCK_SERIALIZATION_FAILED",
                "Outbox payload exceeds the configured limit.",
              );
          }
          const previousVersion = loadedVersion;
          const nextVersion = incrementVersion(previousVersion);
          const applied = await binding.applyPrimary(transaction, {
            resource,
            fromState: binding.getState(resource),
            toState: normalized.event.to,
            expectedVersion,
            nextVersion,
            mutation,
          });
          if (applied.status === "not-found") rollback({ status: "not-found" });
          if (applied.status === "conflict")
            rollback({
              status: "conflict",
              expected: normalized.expectedVersion,
              ...(applied.actual ? { actual: applied.actual } : {}),
            });
          await binding.applyRelated?.(transaction, {
            previousResource: resource,
            updatedResource: applied.resource,
            mutation,
            transitionId,
            occurredAt,
          });
          const actorIdentity = lifecycle.history.actor?.(request.actor) ?? {};
          const metadata = lifecycle.history.metadata?.({
            request: {
              resourceId: request.id,
              event: request.event,
              ...(request.metadata === undefined
                ? {}
                : { metadata: request.metadata }),
            },
            actor: request.actor,
            resource,
          });
          if (metadata !== undefined) assertJsonValue(metadata);
          const transitionRecord = await driver.insertTransition(transaction, {
            id: transitionId,
            lifecycle: lifecycle.name,
            resourceType: lifecycle.history.resourceType,
            resourceId: request.id,
            event: request.event,
            fromState: binding.getState(resource),
            toState: normalized.event.to,
            previousVersion,
            nextVersion,
            occurredAt,
            ...actorIdentity,
            ...(auditData === undefined ? {} : { auditData }),
            ...(metadata === undefined ? {} : { metadata }),
            ...(request.correlationId === undefined
              ? {}
              : { correlationId: request.correlationId }),
            ...(request.causationId === undefined
              ? {}
              : { causationId: request.causationId }),
            ...(request.idempotency
              ? {
                  idempotencyKey: request.idempotency.key,
                  requestFingerprint: normalized.fingerprint!,
                }
              : {}),
            ...(lifecycle.definitionVersion === undefined
              ? {}
              : { definitionVersion: lifecycle.definitionVersion }),
          });
          await driver.insertOutbox(
            transaction,
            descriptors.map((descriptor) => ({
              id: ids(),
              lifecycle: lifecycle.name,
              resourceType: lifecycle.history.resourceType,
              resourceId: request.id,
              transitionId,
              topic: descriptor.topic,
              ...(descriptor.key === undefined ? {} : { key: descriptor.key }),
              payload: descriptor.payload,
              createdAt: occurredAt,
            })),
          );
          if (request.idempotency)
            await driver.completeIdempotency(transaction, {
              lifecycle: lifecycle.name,
              resourceId: request.id,
              key: request.idempotency.key,
              transitionId,
              completedAt: occurredAt,
            });
          const hydrated = binding.hydrateBeforeCommit
            ? await binding.hydrateBeforeCommit(transaction, applied.resource)
            : applied.resource;
          return {
            status: "committed",
            duplicate: false,
            resource: hydrated,
            transition: transitionRecord,
          };
        },
        binding.transactionOptions({
          mode: "authoritative",
          event: request.event,
        }),
      );
    } catch (error) {
      if (error instanceof RollbackOutcome) return error.result;
      throw error;
    }
  }

  return {
    assess,
    transition,
    consistency: (event: string) => binding.consistency(event),
  };
}
