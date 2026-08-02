import { randomUUID } from "node:crypto";
import { InterlockError, isInterlockError } from "./errors.js";
import { assertJsonValue, snapshotJsonValue } from "./json.js";
import type {
  EventMap,
  EventSchemaMap,
  FingerprintArgs,
  IdempotencyConfiguration,
  MutationMap,
  Lifecycle,
  ParsedInputOf,
  SubmittedInputOf,
} from "./lifecycle.js";
import type {
  AssessmentResult,
  JsonValue,
  InterlockOperation,
  OutboxInsert,
  PublicDenial,
  RelatedDataConsistency,
  ResourceBinding,
  TransactionDriver,
  TransitionRecord,
  TransitionResult,
  VersionExpectation,
  VersionToken,
  TransactionOptions,
  WriteOperation,
} from "./types.js";
import { incrementVersion, parseVersionToken } from "./version.js";

type EventName<Events> = Extract<keyof Events, string>;
type InputField<SchemaType> = [SubmittedInputOf<SchemaType>] extends [undefined]
  ? { input?: undefined }
  : { input: SubmittedInputOf<SchemaType> };

type ActorField<Actor> = [Actor] extends [undefined | void]
  ? { actor?: undefined }
  : { actor: Actor };

type IdempotencyField<Enabled extends boolean> = Enabled extends true
  ? { idempotency?: { key: string } }
  : { idempotency?: never };

type CommonRequest<Actor> = ActorField<Actor> & {
  id: string;
  metadata?: JsonValue;
  correlationId?: string;
  causationId?: string;
};

type EventSchema<Event> = Event extends { input: infer SchemaType }
  ? SchemaType
  : undefined;

export type TransitionRequestFor<
  Events,
  Actor,
  SupportsIdempotency extends boolean = boolean,
> = {
  [Event in EventName<Events>]: CommonRequest<Actor> &
    InputField<EventSchema<Events[Event]>> & {
      event: Event;
      expectedVersion: string | "use-loaded-version";
    } & IdempotencyField<SupportsIdempotency>;
}[EventName<Events>];

export type AssessmentRequestFor<Events, Actor> = {
  [Event in EventName<Events>]: CommonRequest<Actor> &
    InputField<EventSchema<Events[Event]>> & { event: Event };
}[EventName<Events>];

/** Typed advisory and authoritative operations for one lifecycle binding. */
export interface InterlockClient<
  Resource,
  Actor,
  Events,
  SupportsIdempotency extends boolean = boolean,
> {
  assess(
    request: AssessmentRequestFor<Events, Actor>,
  ): Promise<AssessmentResult>;
  transition(
    request: TransitionRequestFor<Events, Actor, SupportsIdempotency>,
  ): Promise<TransitionResult<Resource>>;
  consistency(
    event: EventName<Events>,
  ): import("./types.js").RelatedDataConsistency;
}

type LifecycleParts<LifecycleValue> =
  LifecycleValue extends Lifecycle<
    infer Resource,
    infer Actor,
    infer Context,
    infer Schemas,
    infer DefinitionMutations,
    infer Events,
    infer Idempotency
  >
    ? {
        resource: Resource;
        actor: Actor;
        context: Context;
        schemas: Schemas;
        definitionMutations: DefinitionMutations;
        events: Events;
        idempotency: Idempotency;
      }
    : never;

/** Derives a complete binding contract from a lifecycle. */
export type BindingFor<Transaction, LifecycleValue> =
  LifecycleParts<LifecycleValue> extends infer Parts
    ? Parts extends {
        resource: unknown;
        actor: unknown;
        context: unknown;
        events: Record<string, unknown>;
      }
      ? ResourceBinding<
          Transaction,
          Parts["resource"],
          Parts["actor"],
          Parts["context"],
          MutationMap<Parts["events"]>
        >
      : never
    : never;

/** Derives the public client type, including actor and idempotency capability. */
export type ClientFor<LifecycleValue> =
  LifecycleParts<LifecycleValue> extends infer Parts
    ? Parts extends {
        resource: unknown;
        actor: unknown;
        events: Record<string, unknown>;
        idempotency: unknown;
      }
      ? InterlockClient<
          Parts["resource"],
          Parts["actor"],
          Parts["events"],
          [Parts["idempotency"]] extends [undefined] ? false : true
        >
      : never
    : never;

interface BoundaryRequest<Actor> {
  id: string;
  actor: Actor;
  metadata?: JsonValue;
  correlationId?: string;
  causationId?: string;
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

function thenable<Value>(
  value: Value | PromiseLike<Value>,
): value is PromiseLike<Value> {
  return record(value) && typeof value.then === "function";
}

function snapshotJson(value: unknown, label: string): JsonValue {
  try {
    return snapshotJsonValue(value);
  } catch (error) {
    throw operational(
      "INTERLOCK_SERIALIZATION_FAILED",
      `${label} is not JSON-safe.`,
      error,
    );
  }
}

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  for (const item of Array.isArray(value) ? value : Object.values(value))
    freezeJson(item);
  return Object.freeze(value);
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
  Schemas extends EventSchemaMap,
  DefinitionMutations extends { [Event in keyof Schemas]: unknown },
  Events extends EventMap<
    Resource,
    Actor,
    Context,
    Schemas,
    DefinitionMutations
  >,
  Idempotency extends IdempotencyConfiguration<Actor, Schemas> | undefined,
>(options: {
  lifecycle: Lifecycle<
    Resource,
    Actor,
    Context,
    Schemas,
    DefinitionMutations,
    Events,
    Idempotency
  >;
  driver: TransactionDriver<Transaction>;
  binding: ResourceBinding<
    Transaction,
    Resource,
    Actor,
    Context,
    MutationMap<Events>
  >;
  ids?: () => string;
  now?: () => Date;
  maxOutboxPayloadBytes?: number;
}): InterlockClient<
  Resource,
  Actor,
  Events,
  [Idempotency] extends [undefined] ? false : true
> {
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
      binding.loadPrimary,
      binding.getId,
      binding.getState,
      binding.getVersion,
      binding.applyPrimary,
    ].some((method) => typeof method !== "function") ||
    (binding.transactionOptions !== undefined &&
      typeof binding.transactionOptions !== "function") ||
    (binding.contextFactory !== undefined &&
      (!record(binding.contextFactory) ||
        typeof binding.contextFactory.create !== "function")) ||
    (typeof binding.consistency !== "function" &&
      !record(binding.consistency)) ||
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
  const consistencyValue = (
    value: unknown,
    label: string,
  ): RelatedDataConsistency => {
    const strategies = new Set([
      "none",
      "row-locking",
      "aggregate-version",
      "dependency-version",
      "serializable",
      "database-constraint",
      "custom",
    ]);
    if (
      !record(value) ||
      typeof value.strategy !== "string" ||
      !strategies.has(value.strategy) ||
      !nonempty(value.notes)
    )
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${label} consistency declaration is invalid.`,
      );
    return Object.freeze({
      strategy: value.strategy as RelatedDataConsistency["strategy"],
      notes: value.notes,
    });
  };
  const staticConsistency =
    typeof binding.consistency === "function"
      ? undefined
      : consistencyValue(binding.consistency, "Binding");
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
    operation: InterlockOperation<Actor, EventName<Schemas>>,
  ): TransactionOptions => {
    try {
      return transactionOptions(
        binding.transactionOptions?.(operation) ?? {},
        operation.mode,
      );
    } catch (error) {
      throw operational(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        `${operation.mode} transaction options failed.`,
        error,
      );
    }
  };
  type LifecycleEvent = EventMap<
    Resource,
    Actor,
    Context,
    Schemas,
    DefinitionMutations
  >[EventName<Schemas>];
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
  type SnapshotRequest = BoundaryRequest<Actor>;
  type SnapshotTransitionRequest = SnapshotRequest & {
    expectedVersion: unknown;
    idempotency?: { key: string };
  };

  function invalidRequestEnvelope(
    request: unknown,
  ): NormalizationFailure | undefined {
    if (!record(request))
      return {
        ok: false,
        result: {
          status: "invalid-input",
          issues: [
            {
              path: ["request"],
              code: "INVALID_REQUEST",
              message: "Request must be an object.",
            },
          ],
        },
      };
    for (const [field, code] of [
      ["correlationId", "INVALID_CORRELATION_ID"],
      ["causationId", "INVALID_CAUSATION_ID"],
    ] as const) {
      const value = request[field];
      if (value !== undefined && !nonempty(value))
        return {
          ok: false,
          result: {
            status: "invalid-input",
            issues: [
              {
                path: [field],
                code,
                message: `${field} must be a non-empty string.`,
              },
            ],
          },
        };
    }
    return undefined;
  }

  function snapshotRequest(request: BoundaryRequest<Actor>): SnapshotRequest {
    const metadata =
      request.metadata === undefined
        ? undefined
        : freezeJson(snapshotJson(request.metadata, "Request metadata"));
    return Object.freeze({
      id: request.id,
      event: request.event,
      actor: request.actor,
      input: request.input,
      ...(metadata === undefined ? {} : { metadata }),
      ...(request.correlationId === undefined
        ? {}
        : { correlationId: request.correlationId }),
      ...(request.causationId === undefined
        ? {}
        : { causationId: request.causationId }),
    });
  }

  function snapshotTransitionRequest(
    request: BoundaryRequest<Actor> & {
      expectedVersion: unknown;
      idempotency?: unknown;
    },
  ): SnapshotTransitionRequest {
    const idempotency = request.idempotency;
    return Object.freeze({
      ...snapshotRequest(request),
      expectedVersion: request.expectedVersion,
      ...(idempotency === undefined
        ? {}
        : {
            idempotency: Object.freeze({
              key:
                record(idempotency) && typeof idempotency.key === "string"
                  ? idempotency.key
                  : "",
            }),
          }),
    });
  }

  function operation(
    request: SnapshotRequest,
    mode: "advisory" | "authoritative",
  ): InterlockOperation<Actor, EventName<Schemas>> {
    return Object.freeze({
      mode,
      id: request.id,
      event: request.event as EventName<Schemas>,
      actor: request.actor,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      ...(request.correlationId === undefined
        ? {}
        : { correlationId: request.correlationId }),
      ...(request.causationId === undefined
        ? {}
        : { causationId: request.causationId }),
    });
  }

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
      (denial.message !== undefined && typeof denial.message !== "string") ||
      (denial.privateMessage !== undefined &&
        typeof denial.privateMessage !== "string")
    )
      throw new InterlockError(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} returned an invalid denial.`,
      );
    let publicDetails: JsonValue | undefined;
    try {
      if (denial.publicDetails !== undefined)
        publicDetails = snapshotJsonValue(denial.publicDetails);
      if (denial.privateDetails !== undefined)
        assertJsonValue(denial.privateDetails);
    } catch (error) {
      throw operational(
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        `${label} returned invalid denial details.`,
        error,
      );
    }
    return {
      allowed: false,
      denial: {
        code: denial.code,
        ...(denial.message === undefined ? {} : { message: denial.message }),
        ...(publicDetails === undefined ? {} : { publicDetails }),
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
    for (const field of [
      "actorType",
      "actorId",
      "correlationId",
      "causationId",
      "definitionVersion",
    ] as const)
      if (value[field] !== undefined && typeof value[field] !== "string")
        throw new InterlockError(
          "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
          `Driver returned an invalid duplicate ${field}.`,
        );
    let auditData: JsonValue | undefined;
    let metadata: JsonValue | undefined;
    try {
      if (value.auditData !== undefined) {
        auditData = snapshotJsonValue(value.auditData);
      }
      if (value.metadata !== undefined) {
        metadata = snapshotJsonValue(value.metadata);
      }
    } catch (cause) {
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        "Driver returned invalid duplicate JSON data.",
        { cause },
      );
    }
    const actorType = value.actorType as string | undefined;
    const actorId = value.actorId as string | undefined;
    const correlationId = value.correlationId as string | undefined;
    const causationId = value.causationId as string | undefined;
    const definitionVersion = value.definitionVersion as string | undefined;
    return {
      id: value.id,
      lifecycle: value.lifecycle,
      resourceType: value.resourceType,
      resourceId: value.resourceId,
      event: value.event,
      fromState: value.fromState,
      toState: value.toState,
      previousVersion: previous.value,
      nextVersion: next.value,
      occurredAt: new Date(value.occurredAt.getTime()),
      ...(actorType === undefined ? {} : { actorType }),
      ...(actorId === undefined ? {} : { actorId }),
      ...(auditData === undefined ? {} : { auditData }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(causationId === undefined ? {} : { causationId }),
      idempotencyKey: value.idempotencyKey,
      requestFingerprint: value.requestFingerprint,
      ...(definitionVersion === undefined ? {} : { definitionVersion }),
    };
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
    const event = lifecycle.getEvent(request.event) as
      LifecycleEvent | undefined;
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
    request: SnapshotTransitionRequest,
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
    if (request.idempotency && !lifecycle.idempotency)
      return {
        ok: false,
        result: {
          status: "invalid-input",
          issues: [
            {
              path: ["idempotency"],
              code: "IDEMPOTENCY_UNSUPPORTED",
              message: "This lifecycle does not support idempotency.",
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
            event: request.event as Extract<keyof Schemas, string>,
            parsedInput: normalized.input,
            actor: request.actor,
            expectedVersion,
          } as FingerprintArgs<Actor, Schemas>)
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
        "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
        "Idempotency fingerprint must return a non-empty string.",
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
    const args = Object.freeze({
      resource,
      actor,
      context,
      input: input as ParsedInputOf<Schemas[keyof Schemas]>,
    });
    let authorization;
    try {
      if (!event.authorize) authorization = undefined;
      else {
        const evaluated = event.authorize(args);
        authorization = decision(
          thenable(evaluated) ? await evaluated : evaluated,
          "Authorization callback",
        );
      }
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
        ...(authorization.denial.message === undefined
          ? {}
          : { message: authorization.denial.message }),
        ...(authorization.denial.publicDetails === undefined
          ? {}
          : { publicDetails: authorization.denial.publicDetails }),
      };
    for (const guard of event.guards ?? []) {
      let result;
      try {
        const evaluated = guard.evaluate(args);
        result = decision(
          thenable(evaluated) ? await evaluated : evaluated,
          `Guard ${guard.name}`,
        );
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
          ...(result.denial.message === undefined
            ? {}
            : { message: result.denial.message }),
          ...(result.denial.publicDetails === undefined
            ? {}
            : { publicDetails: result.denial.publicDetails }),
        };
    }
    return undefined;
  }

  async function assess(
    request: AssessmentRequestFor<Events, Actor>,
  ): Promise<AssessmentResult> {
    const invalidEnvelope = invalidRequestEnvelope(request);
    if (invalidEnvelope) return invalidEnvelope.result;
    const command = snapshotRequest(request as BoundaryRequest<Actor>);
    const normalized = await normalizeEvent(command);
    if (!normalized.ok) return normalized.result;
    const advisoryOperation = operation(command, "advisory");
    const advisoryOptions = {
      ...resolveTransactionOptions(advisoryOperation),
      readOnly: true,
    };
    try {
      return await driver.transaction(async (transaction) => {
        let resource;
        try {
          resource = await binding.loadPrimary(transaction, advisoryOperation);
        } catch (error) {
          throw operational(
            "INTERLOCK_PERSISTENCE_FAILED",
            "Primary resource load failed.",
            error,
          );
        }
        if (!resource) return { status: "not-found" };
        const loaded = resourceSnapshot(resource, "Loaded resource");
        if (loaded.id !== command.id)
          throw new InterlockError(
            "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
            "Binding loaded a resource with the wrong identity.",
          );
        const currentState = loaded.state;
        const currentVersion = loaded.version;
        const assertBoundary = () => {
          const current = resourceSnapshot(resource, "Loaded resource");
          if (
            current.id !== command.id ||
            current.state !== currentState ||
            current.version !== currentVersion
          )
            throw new InterlockError(
              "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
              "Lifecycle callbacks mutated the loaded resource identity, state, or version.",
            );
        };
        let context: Context;
        try {
          if (!binding.contextFactory) context = undefined as Context;
          else {
            const created = binding.contextFactory.create(
              transaction,
              advisoryOperation,
            );
            context = thenable(created) ? await created : created;
          }
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
          command.actor,
          context,
          normalized.input,
          currentState,
          assertBoundary,
        );
        return reason
          ? {
              status: "denied",
              event: command.event,
              currentState,
              targetState: normalized.event.to,
              reason,
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
    request: TransitionRequestFor<Events, Actor>,
  ): Promise<TransitionResult<Resource>> {
    const invalidEnvelope = invalidRequestEnvelope(request);
    if (invalidEnvelope) return invalidEnvelope.result;
    const command = snapshotTransitionRequest(
      request as BoundaryRequest<Actor> & {
        expectedVersion: unknown;
        idempotency?: unknown;
      },
    );
    const normalized = await normalizeTransition(command);
    if (!normalized.ok) return normalized.result;
    const authoritativeOperation = operation(command, "authoritative");
    const authoritativeOptions = resolveTransactionOptions(
      authoritativeOperation,
    );
    if (authoritativeOptions.readOnly === true)
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        "Authoritative transactions cannot be read-only.",
      );
    if (
      command.idempotency &&
      (authoritativeOptions.isolation ?? "read-committed") !== "read-committed"
    )
      throw new InterlockError(
        "INTERLOCK_DRIVER_UNSUPPORTED",
        "Idempotent transitions require read-committed isolation.",
      );
    try {
      return await driver.transaction(async (transaction) => {
        if (command.idempotency) {
          let claim;
          const createdAt = timestamp("Idempotency claim");
          const createdTime = createdAt.getTime();
          try {
            claim = idempotencyResult(
              await driver.claimIdempotency(transaction, {
                lifecycle: lifecycle.name,
                resourceId: command.id,
                key: command.idempotency.key,
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
              key: command.idempotency.key,
            };
          if (claim.status === "duplicate")
            return {
              status: "committed",
              duplicate: true,
              transition: duplicateTransition(
                claim.transition,
                {
                  id: command.id,
                  event: command.event,
                  idempotency: command.idempotency,
                },
                normalized.fingerprint as string,
              ),
            };
        }

        let resource;
        try {
          resource = await binding.loadPrimary(
            transaction,
            authoritativeOperation,
          );
        } catch (error) {
          throw operational(
            "INTERLOCK_PERSISTENCE_FAILED",
            "Primary resource load failed.",
            error,
          );
        }
        if (!resource) rollback({ status: "not-found" });
        const loaded = resourceSnapshot(resource, "Loaded resource");
        if (loaded.id !== command.id)
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
        let context: Context;
        try {
          if (!binding.contextFactory) context = undefined as Context;
          else {
            const created = binding.contextFactory.create(
              transaction,
              authoritativeOperation,
            );
            context = thenable(created) ? await created : created;
          }
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
          command.actor,
          context,
          normalized.input,
          fromState,
          assertBoundary,
        );
        if (reason)
          rollback({
            status: "denied",
            event: command.event,
            currentState: fromState,
            targetState: normalized.event.to,
            reason,
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
        const projection = Object.freeze({
          resource,
          actor: command.actor,
          context,
          input: normalized.input as ParsedInputOf<Schemas[keyof Schemas]>,
          operation: authoritativeOperation,
          transitionId,
          clock: Object.freeze({ occurredAt }),
        });
        let mutation;
        try {
          const projected = normalized.event.mutate?.(projection);
          mutation =
            projected === undefined
              ? undefined
              : thenable(projected)
                ? await projected
                : projected;
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
          const projected = normalized.event.audit?.(projection);
          auditData =
            projected === undefined
              ? undefined
              : thenable(projected)
                ? await projected
                : projected;
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "Audit projection failed.",
            error,
          );
        }
        assertBoundary();
        assertClock();
        if (auditData !== undefined)
          auditData = snapshotJson(auditData, "Audit data");
        let descriptors;
        try {
          const projected = normalized.event.outbox?.(projection);
          descriptors =
            projected === undefined
              ? []
              : thenable(projected)
                ? await projected
                : projected;
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
        const plannedDescriptors = descriptors.map((descriptor) => {
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
          const payload = snapshotJson(descriptor.payload, "Outbox payload");
          if (
            Buffer.byteLength(JSON.stringify(payload)) > maxOutboxPayloadBytes
          )
            throw new InterlockError(
              "INTERLOCK_SERIALIZATION_FAILED",
              "Outbox payload exceeds the configured limit.",
            );
          return Object.freeze({
            topic: descriptor.topic,
            ...(descriptor.key === undefined ? {} : { key: descriptor.key }),
            payload,
          });
        });
        let actorIdentity;
        try {
          const projected = lifecycle.history.actor?.(command.actor);
          actorIdentity =
            projected === undefined
              ? {}
              : thenable(projected)
                ? await projected
                : projected;
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
        const actorType = actorIdentity.actorType as string | undefined;
        const actorId = actorIdentity.actorId as string | undefined;
        let metadata;
        try {
          const projected = lifecycle.history.metadata?.(
            Object.freeze({
              request: Object.freeze({
                resourceId: command.id,
                event: command.event,
                ...(command.metadata === undefined
                  ? {}
                  : { metadata: command.metadata }),
              }),
              actor: command.actor,
              resource,
            }),
          );
          metadata =
            projected === undefined
              ? undefined
              : thenable(projected)
                ? await projected
                : projected;
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "History metadata projection failed.",
            error,
          );
        }
        assertBoundary();
        assertClock();
        if (metadata !== undefined)
          metadata = snapshotJson(metadata, "History metadata");

        const outboxMessages: readonly OutboxInsert[] = plannedDescriptors.map(
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
        const transitionValue: TransitionRecord = {
          id: transitionId,
          lifecycle: lifecycle.name,
          resourceType: lifecycle.history.resourceType,
          resourceId: command.id,
          event: command.event,
          fromState,
          toState: normalized.event.to,
          previousVersion,
          nextVersion,
          occurredAt: new Date(occurredTime),
          ...(actorType === undefined ? {} : { actorType }),
          ...(actorId === undefined ? {} : { actorId }),
          ...(auditData === undefined ? {} : { auditData }),
          ...(metadata === undefined ? {} : { metadata }),
          ...(command.correlationId === undefined
            ? {}
            : { correlationId: command.correlationId }),
          ...(command.causationId === undefined
            ? {}
            : { causationId: command.causationId }),
          ...(command.idempotency
            ? {
                idempotencyKey: command.idempotency.key,
                requestFingerprint: normalized.fingerprint as string,
              }
            : {}),
          ...(lifecycle.definitionVersion === undefined
            ? {}
            : { definitionVersion: lifecycle.definitionVersion }),
        };
        const writeOperation = Object.freeze({
          ...authoritativeOperation,
          mutation,
        }) as WriteOperation<Actor, MutationMap<Events>>;
        let applied: Awaited<ReturnType<typeof binding.applyPrimary>>;
        try {
          applied = await binding.applyPrimary(transaction, {
            resource,
            fromState,
            toState: normalized.event.to,
            expectedVersion,
            nextVersion,
            operation: writeOperation,
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
          let actual;
          if (applied.actual !== undefined) {
            const version = record(applied.actual)
              ? parseVersionToken(applied.actual.version)
              : { success: false as const };
            if (
              !record(applied.actual) ||
              !nonempty(applied.actual.state) ||
              !version.success
            )
              throw new InterlockError(
                "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
                "Binding returned an invalid conflict snapshot.",
              );
            actual = { state: applied.actual.state, version: version.value };
          }
          rollback({
            status: "conflict",
            expected: normalized.expectedVersion,
            ...(actual ? { actual } : {}),
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
            operation: writeOperation,
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
        if (command.idempotency) {
          try {
            await driver.completeIdempotency(transaction, {
              lifecycle: lifecycle.name,
              resourceId: command.id,
              key: command.idempotency.key,
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
            hydrated = await binding.hydrateBeforeCommit(transaction, {
              resource: applied.resource,
              operation: writeOperation,
            });
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
    consistency: (event: EventName<Schemas>) => {
      if (staticConsistency) return staticConsistency;
      try {
        return consistencyValue(
          (
            binding.consistency as (
              event: EventName<Schemas>,
            ) => RelatedDataConsistency
          )(event),
          `Event ${event}`,
        );
      } catch (error) {
        throw operational(
          "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
          `Event ${event} consistency declaration failed.`,
          error,
        );
      }
    },
  };
}
