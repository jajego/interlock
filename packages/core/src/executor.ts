import { randomUUID } from "node:crypto";
import { InterlockError, isInterlockError } from "./errors.js";
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
  JsonValue,
  OutboxInsert,
  PublicDenial,
  ResourceBinding,
  TransactionDriver,
  TransitionRecord,
  TransitionResult,
  VersionExpectation,
  VersionToken,
  TransactionOptions,
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
    | "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION"
    | "INTERLOCK_DRIVER_PROTOCOL_VIOLATION"
    | "INTERLOCK_PERSISTENCE_FAILED"
    | "INTERLOCK_HISTORY_FAILED"
    | "INTERLOCK_OUTBOX_FAILED"
    | "INTERLOCK_SERIALIZATION_FAILED",
  message: string,
  cause: unknown,
): InterlockError {
  return isInterlockError(cause)
    ? cause
    : new InterlockError(code, message, { cause });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
  return isInterlockError(error)
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
  if (!options || typeof options !== "object")
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Interlock options are required.",
    );
  const { lifecycle, driver, binding } = options;
  if (
    !record(lifecycle) ||
    !nonempty(lifecycle.name) ||
    !record(lifecycle.history) ||
    !nonempty(lifecycle.history.resourceType) ||
    typeof lifecycle.getEvent !== "function" ||
    typeof lifecycle.parseInput !== "function"
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Lifecycle must be created by defineLifecycle().",
    );
  if (
    !record(driver) ||
    [
      driver.transaction,
      driver.claimIdempotency,
      driver.completeIdempotency,
      driver.insertTransition,
      driver.insertOutbox,
    ].some((method) => typeof method !== "function")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Transaction driver is incomplete.",
    );
  if (
    !record(binding) ||
    [
      binding.transactionOptions,
      binding.loadPrimary,
      binding.getId,
      binding.getState,
      binding.getVersion,
      binding.applyPrimary,
      binding.consistency,
    ].some((method) => typeof method !== "function") ||
    !record(binding.contextFactory) ||
    typeof binding.contextFactory.create !== "function" ||
    (binding.applyRelated !== undefined &&
      typeof binding.applyRelated !== "function") ||
    (binding.hydrateBeforeCommit !== undefined &&
      typeof binding.hydrateBeforeCommit !== "function")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Resource binding is incomplete.",
    );
  if (options.ids !== undefined && typeof options.ids !== "function")
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "ID provider must be callable.",
    );
  if (options.now !== undefined && typeof options.now !== "function")
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Clock provider must be callable.",
    );
  if (
    options.maxOutboxPayloadBytes !== undefined &&
    (!Number.isInteger(options.maxOutboxPayloadBytes) ||
      options.maxOutboxPayloadBytes <= 0)
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Maximum outbox payload size must be a positive integer.",
    );
  const ids = options.ids ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const maxOutboxPayloadBytes = options.maxOutboxPayloadBytes ?? 256_000;
  const allocateId = (label: string): string => {
    let id: unknown;
    try {
      id = ids();
    } catch (error) {
      throw operational(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} ID allocation failed.`,
        error,
      );
    }
    if (typeof id !== "string" || id.length === 0)
      throw new InterlockError(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} ID generator must return a non-empty string.`,
      );
    return id;
  };
  const timestamp = (label: string): Date => {
    let value: unknown;
    try {
      value = now();
    } catch (error) {
      throw operational(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} clock allocation failed.`,
        error,
      );
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new InterlockError(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} clock must return a finite Date.`,
      );
    return new Date(value.getTime());
  };
  const transactionOptions = (
    value: unknown,
    label: string,
  ): TransactionOptions => {
    if (!record(value))
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${label} transaction options must be an object.`,
      );
    const isolation = value.isolation;
    if (
      isolation !== undefined &&
      isolation !== "read-committed" &&
      isolation !== "repeatable-read" &&
      isolation !== "serializable"
    )
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${label} transaction isolation is invalid.`,
      );
    if (value.readOnly !== undefined && typeof value.readOnly !== "boolean")
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${label} read-only option is invalid.`,
      );
    return {
      ...(isolation === undefined ? {} : { isolation }),
      ...(value.readOnly === undefined ? {} : { readOnly: value.readOnly }),
    };
  };
  const resolveTransactionOptions = (
    mode: "advisory" | "authoritative",
    event: string,
  ): TransactionOptions => {
    try {
      return transactionOptions(
        binding.transactionOptions({ mode, event }),
        mode,
      );
    } catch (error) {
      throw operational(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${mode} transaction options failed.`,
        error,
      );
    }
  };
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

  function decision(value: unknown, label: string) {
    if (value === true || (record(value) && value.allowed === true))
      return { allowed: true } as const;
    if (value === false)
      return { allowed: false, denial: { code: "DENIED" } } as const;
    if (!record(value) || value.allowed !== false || !record(value.denial))
      throw new InterlockError(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} returned an invalid decision.`,
      );
    const denial = value.denial;
    if (
      !nonempty(denial.code) ||
      (denial.publicMessage !== undefined &&
        typeof denial.publicMessage !== "string") ||
      (denial.privateMessage !== undefined &&
        typeof denial.privateMessage !== "string")
    )
      throw new InterlockError(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} returned an invalid denial.`,
      );
    if (denial.details !== undefined) {
      try {
        assertJsonValue(denial.details);
      } catch (error) {
        throw operational(
          "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
          `${label} returned invalid denial details.`,
          error,
        );
      }
    }
    return {
      allowed: false,
      denial: {
        code: denial.code,
        ...(denial.publicMessage === undefined
          ? {}
          : { publicMessage: denial.publicMessage }),
      },
    } as const;
  }

  function resourceSnapshot(value: Resource, label: string) {
    try {
      const id = binding.getId(value);
      const state = binding.getState(value);
      const version = binding.getVersion(value);
      const parsed = parseVersionToken(version);
      if (!nonempty(id) || !nonempty(state) || !parsed.success)
        throw new InterlockError(
          "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
          `${label} has invalid identity, state, or version.`,
        );
      return { id, state, version: parsed.value };
    } catch (error) {
      throw operational(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${label} is malformed.`,
        error,
      );
    }
  }

  function duplicateTransition(
    value: unknown,
    request: { id: string; event: string; idempotency: { key: string } },
    fingerprint: string,
  ): TransitionRecord {
    if (!record(value))
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Driver returned a malformed duplicate transition.",
      );
    const previous = parseVersionToken(value.previousVersion);
    const next = parseVersionToken(value.nextVersion);
    if (
      value.lifecycle !== lifecycle.name ||
      value.resourceType !== lifecycle.history.resourceType ||
      value.resourceId !== request.id ||
      value.event !== request.event ||
      value.idempotencyKey !== request.idempotency.key ||
      value.requestFingerprint !== fingerprint ||
      !nonempty(value.id) ||
      !nonempty(value.fromState) ||
      !nonempty(value.toState) ||
      !previous.success ||
      !next.success ||
      BigInt(next.value) !== BigInt(previous.value) + 1n ||
      !(value.occurredAt instanceof Date) ||
      !Number.isFinite(value.occurredAt.getTime())
    )
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Driver returned an unrelated or malformed duplicate transition.",
      );
    return value as unknown as TransitionRecord;
  }

  function idempotencyResult(value: unknown) {
    if (!record(value) || !nonempty(value.status))
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Driver returned an invalid idempotency result.",
      );
    if (value.status === "claimed" || value.status === "conflict")
      return { status: value.status } as const;
    if (value.status === "duplicate" && "transition" in value)
      return { status: "duplicate", transition: value.transition } as const;
    throw new InterlockError(
      "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
      "Driver returned an invalid idempotency result.",
    );
  }

  async function normalizeEvent(
    request: BoundaryRequest<Actor>,
  ): Promise<NormalizationFailure | NormalizedEvent> {
    if (!nonempty(request.id))
      return {
        ok: false,
        result: {
          status: "invalid-input",
          issues: [
            {
              path: ["id"],
              code: "INVALID_RESOURCE_ID",
              message: "Resource ID must be a non-empty string.",
            },
          ],
        },
      };
    if (!nonempty(request.event))
      return {
        ok: false,
        result: { status: "unknown-event", event: String(request.event) },
      };
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
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
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
    if (
      request.idempotency &&
      (typeof request.idempotency.key !== "string" ||
        request.idempotency.key.length === 0)
    )
      return {
        ok: false,
        result: {
          status: "invalid-input",
          issues: [
            {
              path: ["idempotency", "key"],
              code: "INVALID_IDEMPOTENCY_KEY",
              message: "Idempotency key must be a non-empty string.",
            },
          ],
        },
      };
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
    state: string,
    assertBoundary: () => void,
  ): Promise<PublicDenial | undefined> {
    if (!event.from.includes(state))
      return { source: "state", code: "INVALID_SOURCE_STATE" };
    const args = {
      resource,
      actor,
      context,
      input: input as ParsedInputOf<Schemas[keyof Schemas]>,
    };
    let authorization;
    try {
      authorization = event.authorize
        ? decision(await event.authorize(args), "Authorization callback")
        : undefined;
    } catch (error) {
      throw operational(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        "Authorization callback failed.",
        error,
      );
    }
    assertBoundary();
    if (authorization && !authorization.allowed)
      return {
        source: "authorization",
        code: authorization.denial.code,
        ...(authorization.denial.publicMessage === undefined
          ? {}
          : { publicMessage: authorization.denial.publicMessage }),
      };
    for (const guard of event.guards ?? []) {
      let result;
      try {
        result = decision(await guard.evaluate(args), `Guard ${guard.name}`);
      } catch (error) {
        throw operational(
          "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
          `Guard ${guard.name} failed.`,
          error,
        );
      }
      assertBoundary();
      if (!result.allowed)
        return {
          source: "guard",
          rule: guard.name,
          code: result.denial.code,
          ...(result.denial.publicMessage === undefined
            ? {}
            : { publicMessage: result.denial.publicMessage }),
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
    const advisoryOptions = {
      ...resolveTransactionOptions("advisory", request.event),
      readOnly: true,
    };
    try {
      return await driver.transaction(async (transaction) => {
        let resource;
        try {
          resource = await binding.loadPrimary(transaction, request.id);
        } catch (error) {
          throw operational(
            "INTERLOCK_PERSISTENCE_FAILED",
            "Primary resource load failed.",
            error,
          );
        }
        if (!resource) return { status: "not-found" };
        const loaded = resourceSnapshot(resource, "Loaded resource");
        if (loaded.id !== request.id)
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding loaded a resource with the wrong identity.",
          );
        const currentState = loaded.state;
        const currentVersion = loaded.version;
        const assertBoundary = () => {
          const current = resourceSnapshot(resource, "Loaded resource");
          if (
            current.id !== request.id ||
            current.state !== currentState ||
            current.version !== currentVersion
          )
            throw new InterlockError(
              "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
              "Lifecycle callbacks mutated the loaded resource identity, state, or version.",
            );
        };
        let context;
        try {
          context = binding.contextFactory.create(transaction, {
            mode: "advisory",
            event: request.event,
          });
        } catch (error) {
          throw operational(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Advisory context creation failed.",
            error,
          );
        }
        const reason = await evaluate(
          normalized.event,
          resource,
          request.actor,
          context,
          normalized.input,
          currentState,
          assertBoundary,
        );
        return reason
          ? {
              status: "denied",
              event: request.event,
              currentState,
              targetState: normalized.event.to,
              reasons: [reason],
            }
          : {
              status: "allowed",
              currentState,
              targetState: normalized.event.to,
            };
      }, advisoryOptions);
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
    const authoritativeOptions = resolveTransactionOptions(
      "authoritative",
      request.event,
    );
    if (
      request.idempotency &&
      (authoritativeOptions.isolation ?? "read-committed") !== "read-committed"
    )
      throw new InterlockError(
        "INTERLOCK_DRIVER_UNSUPPORTED",
        "Idempotent transitions require read-committed isolation.",
      );
    try {
      return await driver.transaction(async (transaction) => {
        if (request.idempotency) {
          let claim;
          const createdAt = timestamp("Idempotency claim");
          const createdTime = createdAt.getTime();
          try {
            claim = idempotencyResult(
              await driver.claimIdempotency(transaction, {
                lifecycle: lifecycle.name,
                resourceId: request.id,
                key: request.idempotency.key,
                fingerprint: normalized.fingerprint as string,
                createdAt,
              }),
            );
          } catch (error) {
            throw operational(
              "INTERLOCK_PERSISTENCE_FAILED",
              "Idempotency claim failed.",
              error,
            );
          }
          if (createdAt.getTime() !== createdTime)
            throw new InterlockError(
              "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
              "Driver mutated the idempotency claim timestamp.",
            );
          if (claim.status === "conflict")
            return {
              status: "idempotency-conflict",
              key: request.idempotency.key,
            };
          if (claim.status === "duplicate")
            return {
              status: "committed",
              duplicate: true,
              transition: duplicateTransition(
                claim.transition,
                {
                  id: request.id,
                  event: request.event,
                  idempotency: request.idempotency,
                },
                normalized.fingerprint as string,
              ),
            };
        }

        let resource;
        try {
          resource = await binding.loadPrimary(transaction, request.id);
        } catch (error) {
          throw operational(
            "INTERLOCK_PERSISTENCE_FAILED",
            "Primary resource load failed.",
            error,
          );
        }
        if (!resource) rollback({ status: "not-found" });
        const loaded = resourceSnapshot(resource, "Loaded resource");
        if (loaded.id !== request.id)
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding loaded a resource with the wrong identity.",
          );
        const resourceId = loaded.id;
        const fromState = loaded.state;
        const loadedVersion = loaded.version;
        const assertBoundary = () => {
          const current = resourceSnapshot(resource, "Loaded resource");
          if (
            current.id !== resourceId ||
            current.state !== fromState ||
            current.version !== loadedVersion
          )
            throw new InterlockError(
              "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
              "Lifecycle callbacks mutated the loaded resource identity, state, or version.",
            );
        };
        if (
          normalized.expectedVersion !== "use-loaded-version" &&
          normalized.expectedVersion !== loadedVersion
        )
          rollback({
            status: "conflict",
            expected: normalized.expectedVersion,
            actual: {
              state: fromState,
              version: loadedVersion,
            },
          });
        const expectedVersion: VersionToken =
          normalized.expectedVersion === "use-loaded-version"
            ? loadedVersion
            : normalized.expectedVersion;
        let context;
        try {
          context = binding.contextFactory.create(transaction, {
            mode: "authoritative",
            event: request.event,
          });
        } catch (error) {
          throw operational(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Authoritative context creation failed.",
            error,
          );
        }
        const reason = await evaluate(
          normalized.event,
          resource,
          request.actor,
          context,
          normalized.input,
          fromState,
          assertBoundary,
        );
        if (reason)
          rollback({
            status: "denied",
            event: request.event,
            currentState: fromState,
            targetState: normalized.event.to,
            reasons: [reason],
          });

        const occurredAt = timestamp("Transition");
        const occurredTime = occurredAt.getTime();
        const assertClock = () => {
          if (occurredAt.getTime() !== occurredTime)
            throw new InterlockError(
              "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
              "Lifecycle callbacks mutated the transition clock.",
            );
        };
        const transitionId = allocateId("Transition");
        const projection = {
          resource,
          actor: request.actor,
          context,
          input: normalized.input as ParsedInputOf<Schemas[keyof Schemas]>,
          transitionId,
          clock: Object.freeze({ occurredAt }),
        };
        let mutation;
        try {
          mutation = normalized.event.mutate(projection);
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "Mutation projection failed.",
            error,
          );
        }
        assertBoundary();
        assertClock();
        let auditData;
        try {
          auditData = normalized.event.audit?.(projection);
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "Audit projection failed.",
            error,
          );
        }
        assertBoundary();
        assertClock();
        let descriptors;
        try {
          descriptors = normalized.event.outbox?.(projection) ?? [];
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "Outbox projection failed.",
            error,
          );
        }
        if (!Array.isArray(descriptors))
          throw new InterlockError(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "Outbox projection must return an array.",
          );
        assertBoundary();
        assertClock();
        let actorIdentity;
        try {
          actorIdentity = lifecycle.history.actor?.(request.actor) ?? {};
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "History actor projection failed.",
            error,
          );
        }
        assertClock();
        if (!record(actorIdentity))
          throw new InterlockError(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "History actor projection must return an object.",
          );
        let metadata;
        try {
          metadata = lifecycle.history.metadata?.({
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
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "History metadata projection failed.",
            error,
          );
        }
        assertBoundary();
        assertClock();
        if (auditData !== undefined) serialize(auditData, "Audit data");
        if (metadata !== undefined) serialize(metadata, "History metadata");
        if (
          (actorIdentity.actorType !== undefined &&
            typeof actorIdentity.actorType !== "string") ||
          (actorIdentity.actorId !== undefined &&
            typeof actorIdentity.actorId !== "string")
        )
          throw new InterlockError(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "History actor projection must return string identity fields.",
          );
        for (const descriptor of descriptors) {
          if (
            !record(descriptor) ||
            typeof descriptor.topic !== "string" ||
            descriptor.topic.length === 0 ||
            (descriptor.key !== undefined && typeof descriptor.key !== "string")
          )
            throw new InterlockError(
              "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
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

        const outboxMessages: readonly OutboxInsert[] = descriptors.map(
          (descriptor) => ({
            id: allocateId("Outbox message"),
            lifecycle: lifecycle.name,
            resourceType: lifecycle.history.resourceType,
            resourceId,
            transitionId,
            topic: descriptor.topic,
            ...(descriptor.key === undefined ? {} : { key: descriptor.key }),
            payload: descriptor.payload,
            createdAt: new Date(occurredTime),
          }),
        );

        const previousVersion = loadedVersion;
        const nextVersion = incrementVersion(previousVersion);
        assertClock();
        let applied: Awaited<ReturnType<typeof binding.applyPrimary>>;
        try {
          applied = await binding.applyPrimary(transaction, {
            resource,
            fromState,
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
        if (!record(applied) || !nonempty(applied.status))
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding returned an invalid primary update result.",
          );
        if (applied.status === "not-found") rollback({ status: "not-found" });
        if (applied.status === "conflict") {
          if (applied.actual !== undefined) {
            if (
              !record(applied.actual) ||
              !nonempty(applied.actual.state) ||
              !parseVersionToken(applied.actual.version).success
            )
              throw new InterlockError(
                "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
                "Binding returned an invalid conflict snapshot.",
              );
          }
          rollback({
            status: "conflict",
            expected: normalized.expectedVersion,
            ...(applied.actual ? { actual: applied.actual } : {}),
          });
        }
        if (applied.status !== "applied" || !("resource" in applied))
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding returned an unknown primary update result.",
          );
        const updated = resourceSnapshot(applied.resource, "Applied resource");
        if (
          updated.id !== resourceId ||
          updated.state !== normalized.event.to ||
          updated.version !== nextVersion
        )
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding returned an applied resource with unexpected identity, state, or version.",
          );
        try {
          await binding.applyRelated?.(transaction, {
            previousResource: resource,
            updatedResource: applied.resource,
            mutation,
            transitionId,
            occurredAt: new Date(occurredTime),
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
          fromState,
          toState: normalized.event.to,
          previousVersion,
          nextVersion,
          occurredAt: new Date(occurredTime),
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
        try {
          await driver.insertTransition(transaction, {
            ...transitionValue,
            occurredAt: new Date(occurredTime),
          });
        } catch (error) {
          throw operational(
            "INTERLOCK_HISTORY_FAILED",
            "Transition history insertion failed.",
            error,
          );
        }
        try {
          await driver.insertOutbox(transaction, outboxMessages);
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
              completedAt: new Date(occurredTime),
            });
          } catch (error) {
            throw operational(
              "INTERLOCK_PERSISTENCE_FAILED",
              "Idempotency completion failed.",
              error,
            );
          }
        }
        let hydrated = applied.resource;
        if (binding.hydrateBeforeCommit) {
          try {
            hydrated = await binding.hydrateBeforeCommit(
              transaction,
              applied.resource,
            );
          } catch (error) {
            throw operational(
              "INTERLOCK_PERSISTENCE_FAILED",
              "In-transaction hydration failed.",
              error,
            );
          }
        }
        const hydratedSnapshot = resourceSnapshot(
          hydrated,
          "Hydrated resource",
        );
        if (
          hydratedSnapshot.id !== resourceId ||
          hydratedSnapshot.state !== normalized.event.to ||
          hydratedSnapshot.version !== nextVersion
        )
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding returned a hydrated resource with unexpected identity, state, or version.",
          );
        return {
          status: "committed",
          duplicate: false,
          resource: hydrated,
          transition: transitionValue,
        };
      }, authoritativeOptions);
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
