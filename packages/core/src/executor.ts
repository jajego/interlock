import { randomUUID } from "node:crypto";
import { InterlockError } from "./errors.js";
import { assertJsonValue } from "./json.js";
import type {
  EventMap,
  EventSchemaMap,
  Lifecycle,
  ParsedInputOf,
  SubmittedInputOf,
} from "./lifecycle.js";
import type {
  AssessmentResult,
  Denial,
  JsonValue,
  ResourceBinding,
  TransactionDriver,
  TransitionRecord,
  TransitionResult,
  VersionExpectation,
  VersionToken,
} from "./types.js";
import { incrementVersion, parseVersionToken } from "./version.js";

type EventName<Schemas extends EventSchemaMap> = Extract<keyof Schemas, string>;
type InputField<SchemaType> = [SubmittedInputOf<SchemaType>] extends [undefined]
  ? { input?: undefined }
  : { input: SubmittedInputOf<SchemaType> };

interface CommonRequest<Actor> {
  id: string;
  actor: Actor;
  metadata?: JsonValue;
  correlationId?: string;
  causationId?: string;
}

export type TransitionRequestFor<Schemas extends EventSchemaMap, Actor> = {
  [Event in EventName<Schemas>]: CommonRequest<Actor> &
    InputField<Schemas[Event]> & {
      event: Event;
      expectedVersion: string | "use-loaded-version";
      idempotency?: { key: string };
    };
}[EventName<Schemas>];

export type AssessmentRequestFor<Schemas extends EventSchemaMap, Actor> = {
  [Event in EventName<Schemas>]: CommonRequest<Actor> &
    InputField<Schemas[Event]> & { event: Event };
}[EventName<Schemas>];

interface BoundaryRequest<Actor> extends CommonRequest<Actor> {
  event: string;
  input?: unknown;
}

class RollbackOutcome<Resource> {
  constructor(readonly result: TransitionResult<Resource>) {}
}

function rollback<Resource>(result: TransitionResult<Resource>): never {
  throw new RollbackOutcome(result);
}

function operational(
  code:
    | "INTERLOCK_BINDING_PROTOCOL_VIOLATION"
    | "INTERLOCK_PERSISTENCE_FAILED"
    | "INTERLOCK_HISTORY_FAILED"
    | "INTERLOCK_OUTBOX_FAILED"
    | "INTERLOCK_SERIALIZATION_FAILED",
  message: string,
  cause: unknown,
): InterlockError {
  return cause instanceof InterlockError
    ? cause
    : new InterlockError(code, message, { cause });
}

function serialize(value: unknown, label: string): asserts value is JsonValue {
  try {
    assertJsonValue(value);
  } catch (error) {
    throw operational(
      "INTERLOCK_SERIALIZATION_FAILED",
      `${label} is not JSON-safe.`,
      error,
    );
  }
}

function unexpected(error: unknown): InterlockError {
  return error instanceof InterlockError
    ? error
    : new InterlockError(
        "INTERLOCK_TRANSACTION_FAILED",
        "Interlock execution failed.",
        { cause: error },
      );
}

export function createInterlock<
  Transaction,
  Resource,
  Actor,
  Context,
  Mutation,
  Schemas extends EventSchemaMap,
>(options: {
  lifecycle: Lifecycle<Resource, Actor, Context, Mutation, Schemas>;
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
  type LifecycleEvent = EventMap<
    Resource,
    Actor,
    Context,
    Mutation,
    Schemas
  >[keyof Schemas];
  type NormalizationFailure = {
    ok: false;
    result:
      | { status: "unknown-event"; event: string }
      | {
          status: "invalid-input";
          issues: readonly import("./types.js").InputIssue[];
        };
  };
  type NormalizedEvent = {
    ok: true;
    event: LifecycleEvent;
    input: unknown;
  };

  async function normalizeEvent(
    request: BoundaryRequest<Actor>,
  ): Promise<NormalizationFailure | NormalizedEvent> {
    const event = lifecycle.getEvent(request.event);
    if (!event)
      return {
        ok: false,
        result: { status: "unknown-event", event: request.event } as const,
      };
    let parsed;
    try {
      parsed = await lifecycle.parseInput(event, request.input);
    } catch (error) {
      throw operational(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        "Input schema threw instead of returning a parse result.",
        error,
      );
    }
    if (!parsed.success)
      return {
        ok: false,
        result: { status: "invalid-input", issues: parsed.issues } as const,
      };
    return { ok: true, event, input: parsed.value };
  }

  async function normalizeTransition(
    request: BoundaryRequest<Actor> & {
      expectedVersion: unknown;
      idempotency?: { key: string };
    },
  ): Promise<
    | NormalizationFailure
    | (NormalizedEvent & {
        expectedVersion: VersionExpectation;
        fingerprint: string | undefined;
      })
  > {
    const normalized = await normalizeEvent(request);
    if (!normalized.ok) return normalized;
    let expectedVersion: VersionExpectation;
    if (request.expectedVersion === "use-loaded-version")
      expectedVersion = request.expectedVersion;
    else {
      const parsedVersion = parseVersionToken(request.expectedVersion);
      if (!parsedVersion.success)
        return {
          ok: false,
          result: {
            status: "invalid-input",
            issues: [parsedVersion.issue],
          } as const,
        };
      expectedVersion = parsedVersion.value;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = request.idempotency
        ? lifecycle.idempotency?.fingerprint({
            lifecycle: lifecycle.name,
            resourceId: request.id,
            event: request.event,
            parsedInput: normalized.input as ParsedInputOf<
              Schemas[keyof Schemas]
            >,
            actor: request.actor,
            expectedVersion,
          })
        : undefined;
    } catch (error) {
      throw operational(
        "INTERLOCK_SERIALIZATION_FAILED",
        "Idempotency fingerprint projection failed.",
        error,
      );
    }
    if (
      request.idempotency &&
      (typeof fingerprint !== "string" || fingerprint.length === 0)
    )
      throw new InterlockError(
        "INTERLOCK_DEFINITION_INVALID",
        "Idempotency requires a fingerprint projection.",
      );
    return { ...normalized, expectedVersion, fingerprint };
  }

  async function evaluate(
    event: LifecycleEvent,
    resource: Resource,
    actor: Actor,
    context: Context,
    input: unknown,
  ): Promise<Denial | undefined> {
    const state = binding.getState(resource);
    if (!event.from.includes(state))
      return { source: "state", code: "INVALID_SOURCE_STATE" };
    const args = {
      resource,
      actor,
      context,
      input: input as ParsedInputOf<Schemas[keyof Schemas]>,
    };
    const authorization = await event.authorize?.(args);
    if (authorization && !authorization.allowed)
      return { ...authorization.denial, source: "authorization" };
    for (const guard of event.guards ?? []) {
      const decision = await guard.evaluate(args);
      if (!decision.allowed)
        return {
          ...decision.denial,
          source: "guard",
          rule: guard.name,
        };
    }
    return undefined;
  }

  async function assess(
    request: AssessmentRequestFor<Schemas, Actor>,
  ): Promise<AssessmentResult> {
    const boundary = request as BoundaryRequest<Actor>;
    const normalized = await normalizeEvent(boundary);
    if (!normalized.ok) return normalized.result;
    try {
      return await driver.transaction(
        async (transaction) => {
          const resource = await binding.loadPrimary(transaction, request.id);
          if (!resource) return { status: "not-found" };
          if (binding.getId(resource) !== request.id)
            throw new InterlockError(
              "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
              "Binding loaded a resource with the wrong identity.",
            );
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
    } catch (error) {
      throw unexpected(error);
    }
  }

  async function transition(
    request: TransitionRequestFor<Schemas, Actor>,
  ): Promise<TransitionResult<Resource>> {
    const boundary = request as BoundaryRequest<Actor> & {
      expectedVersion: unknown;
      idempotency?: { key: string };
    };
    const normalized = await normalizeTransition(boundary);
    if (!normalized.ok) return normalized.result;
    try {
      return await driver.transaction(
        async (transaction) => {
          if (request.idempotency) {
            const claim = await driver.claimIdempotency(transaction, {
              lifecycle: lifecycle.name,
              resourceId: request.id,
              key: request.idempotency.key,
              fingerprint: normalized.fingerprint as string,
              createdAt: now(),
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
          if (binding.getId(resource) !== request.id)
            throw new InterlockError(
              "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
              "Binding loaded a resource with the wrong identity.",
            );
          const loadedVersion = binding.getVersion(resource);
          if (
            normalized.expectedVersion !== "use-loaded-version" &&
            normalized.expectedVersion !== loadedVersion
          )
            rollback({
              status: "conflict",
              expected: normalized.expectedVersion,
              actual: {
                state: binding.getState(resource),
                version: loadedVersion,
              },
            });
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

          const occurredAt = now();
          const transitionId = ids();
          const projection = {
            resource,
            actor: request.actor,
            context,
            input: normalized.input as ParsedInputOf<Schemas[keyof Schemas]>,
            transitionId,
            clock: { occurredAt },
          };
          const mutation = normalized.event.mutate(projection);
          const auditData = normalized.event.audit?.(projection);
          const descriptors = normalized.event.outbox?.(projection) ?? [];
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
          if (auditData !== undefined) serialize(auditData, "Audit data");
          if (metadata !== undefined) serialize(metadata, "History metadata");
          if (
            (actorIdentity.actorType !== undefined &&
              typeof actorIdentity.actorType !== "string") ||
            (actorIdentity.actorId !== undefined &&
              typeof actorIdentity.actorId !== "string")
          )
            throw new InterlockError(
              "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
              "History actor projection must return string identity fields.",
            );
          for (const descriptor of descriptors) {
            if (
              typeof descriptor.topic !== "string" ||
              descriptor.topic.length === 0 ||
              (descriptor.key !== undefined &&
                typeof descriptor.key !== "string")
            )
              throw new InterlockError(
                "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
                "Outbox descriptors require a topic and optional string key.",
              );
            serialize(descriptor.payload, "Outbox payload");
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
          let applied: Awaited<ReturnType<typeof binding.applyPrimary>>;
          try {
            applied = await binding.applyPrimary(transaction, {
              resource,
              fromState: binding.getState(resource),
              toState: normalized.event.to,
              expectedVersion,
              nextVersion,
              mutation,
            });
          } catch (error) {
            throw operational(
              "INTERLOCK_PERSISTENCE_FAILED",
              "Primary resource update failed.",
              error,
            );
          }
          if (applied.status === "not-found") rollback({ status: "not-found" });
          if (applied.status === "conflict")
            rollback({
              status: "conflict",
              expected: normalized.expectedVersion,
              ...(applied.actual ? { actual: applied.actual } : {}),
            });
          try {
            await binding.applyRelated?.(transaction, {
              previousResource: resource,
              updatedResource: applied.resource,
              mutation,
              transitionId,
              occurredAt,
            });
          } catch (error) {
            throw operational(
              "INTERLOCK_PERSISTENCE_FAILED",
              "Related resource update failed.",
              error,
            );
          }

          const transitionValue: TransitionRecord = {
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
            ...(actorIdentity.actorType === undefined
              ? {}
              : { actorType: actorIdentity.actorType }),
            ...(actorIdentity.actorId === undefined
              ? {}
              : { actorId: actorIdentity.actorId }),
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
                  requestFingerprint: normalized.fingerprint as string,
                }
              : {}),
            ...(lifecycle.definitionVersion === undefined
              ? {}
              : { definitionVersion: lifecycle.definitionVersion }),
          };
          let transitionRecord: TransitionRecord;
          try {
            transitionRecord = await driver.insertTransition(
              transaction,
              transitionValue,
            );
          } catch (error) {
            throw operational(
              "INTERLOCK_HISTORY_FAILED",
              "Transition history insertion failed.",
              error,
            );
          }
          try {
            await driver.insertOutbox(
              transaction,
              descriptors.map((descriptor) => ({
                id: ids(),
                lifecycle: lifecycle.name,
                resourceType: lifecycle.history.resourceType,
                resourceId: request.id,
                transitionId,
                topic: descriptor.topic,
                ...(descriptor.key === undefined
                  ? {}
                  : { key: descriptor.key }),
                payload: descriptor.payload,
                createdAt: occurredAt,
              })),
            );
          } catch (error) {
            throw operational(
              "INTERLOCK_OUTBOX_FAILED",
              "Outbox insertion failed.",
              error,
            );
          }
          if (request.idempotency) {
            try {
              await driver.completeIdempotency(transaction, {
                lifecycle: lifecycle.name,
                resourceId: request.id,
                key: request.idempotency.key,
                transitionId,
                completedAt: occurredAt,
              });
            } catch (error) {
              throw operational(
                "INTERLOCK_PERSISTENCE_FAILED",
                "Idempotency completion failed.",
                error,
              );
            }
          }
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
      throw unexpected(error);
    }
  }

  return {
    assess,
    transition,
    consistency: (event: EventName<Schemas>) => binding.consistency(event),
  };
}
