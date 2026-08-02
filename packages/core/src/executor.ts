import { randomUUID } from "node:crypto";
import { InterlockError, isInterlockError } from "./errors.js";
import type {
  EventMap,
  EventSchemaMap,
  FingerprintArgs,
  IdempotencyConfiguration,
  MutationMap,
  Lifecycle,
  ParsedInputOf,
} from "./lifecycle.js";
import {
  nonempty,
  operational,
  publicDenial,
  record,
  snapshotActorIdentity,
  snapshotConsistency,
  snapshotDecision,
  snapshotDuplicateTransition,
  snapshotIdempotencyResult,
  snapshotJson,
  snapshotOutboxDescriptor,
  snapshotPrimaryResult,
  snapshotTransactionOptions,
} from "./protocol.js";
import {
  operationFor,
  snapshotAssessmentRequest,
  snapshotTransitionRequest,
  type AssessmentRequestFor,
  type SnapshotRequest,
  type SnapshotTransitionRequest,
  type TransitionRequestFor,
} from "./request.js";
import type {
  AssessmentResult,
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

/** Typed advisory and authoritative operations for one lifecycle binding. */
export interface InterlockClient<
  Resource,
  Actor,
  Events,
  SupportsIdempotency extends boolean = boolean,
> {
  /**
   * Runs advisory policy in a read-only transaction. It reserves nothing;
   * `transition()` repeats loading and policy checks authoritatively.
   */
  assess(
    request: AssessmentRequestFor<Events, Actor>,
  ): Promise<AssessmentResult>;
  /**
   * Owns one write transaction. Expected domain outcomes are returned;
   * operational failures throw `InterlockError`. A duplicate returns stored
   * history and does not hydrate current resource state.
   */
  transition(
    request: TransitionRequestFor<Events, Actor, SupportsIdempotency>,
  ): Promise<TransitionResult<Resource>>;
  /** Returns the binding's detached related-data consistency declaration. */
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

class RollbackOutcome<Resource> {
  constructor(readonly result: TransitionResult<Resource>) {}
}

function rollback<Resource>(result: TransitionResult<Resource>): never {
  throw new RollbackOutcome(result);
}

function settlement<Value>(
  value: Value | PromiseLike<Value>,
): Promise<Value> | undefined {
  if (!record(value)) return undefined;
  const then = value.then;
  if (typeof then !== "function") return undefined;
  return new Promise((resolve, reject) => {
    then.call(value, resolve, reject);
  });
}

function bindMethod(method: unknown, receiver: object) {
  return (method as (...args: never[]) => unknown).bind(receiver);
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

/**
 * Binds one validated lifecycle to application persistence and a transaction
 * driver. Interlock owns transactions started through the returned client.
 */
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
  const lifecycleValue = options.lifecycle;
  const driverValue = options.driver;
  const bindingValue = options.binding;
  const idsValue = options.ids;
  const nowValue = options.now;
  const maxOutboxPayloadBytesValue = options.maxOutboxPayloadBytes;
  const lifecycleName = record(lifecycleValue)
    ? lifecycleValue.name
    : undefined;
  const lifecycleHistory = record(lifecycleValue)
    ? lifecycleValue.history
    : undefined;
  const resourceType = record(lifecycleHistory)
    ? lifecycleHistory.resourceType
    : undefined;
  const historyActor = record(lifecycleHistory)
    ? lifecycleHistory.actor
    : undefined;
  const historyMetadata = record(lifecycleHistory)
    ? lifecycleHistory.metadata
    : undefined;
  const getEvent = record(lifecycleValue) ? lifecycleValue.getEvent : undefined;
  const parseInput = record(lifecycleValue)
    ? lifecycleValue.parseInput
    : undefined;
  const lifecycleIdempotency = record(lifecycleValue)
    ? lifecycleValue.idempotency
    : undefined;
  const fingerprint = record(lifecycleIdempotency)
    ? lifecycleIdempotency.fingerprint
    : undefined;
  if (
    !record(lifecycleValue) ||
    !nonempty(lifecycleName) ||
    !record(lifecycleHistory) ||
    !nonempty(resourceType) ||
    typeof getEvent !== "function" ||
    typeof parseInput !== "function"
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Lifecycle must be created by defineLifecycle().",
    );
  const driverTransaction = record(driverValue)
    ? driverValue.transaction
    : undefined;
  const claimIdempotency = record(driverValue)
    ? driverValue.claimIdempotency
    : undefined;
  const completeIdempotency = record(driverValue)
    ? driverValue.completeIdempotency
    : undefined;
  const insertTransition = record(driverValue)
    ? driverValue.insertTransition
    : undefined;
  const insertOutbox = record(driverValue)
    ? driverValue.insertOutbox
    : undefined;
  if (
    !record(driverValue) ||
    [
      driverTransaction,
      claimIdempotency,
      completeIdempotency,
      insertTransition,
      insertOutbox,
    ].some((method) => typeof method !== "function")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Transaction driver is incomplete.",
    );
  const transactionOptionsValue = record(bindingValue)
    ? bindingValue.transactionOptions
    : undefined;
  const loadPrimary = record(bindingValue)
    ? bindingValue.loadPrimary
    : undefined;
  const getId = record(bindingValue) ? bindingValue.getId : undefined;
  const getState = record(bindingValue) ? bindingValue.getState : undefined;
  const getVersion = record(bindingValue) ? bindingValue.getVersion : undefined;
  const applyPrimary = record(bindingValue)
    ? bindingValue.applyPrimary
    : undefined;
  const applyRelated = record(bindingValue)
    ? bindingValue.applyRelated
    : undefined;
  const hydrateBeforeCommit = record(bindingValue)
    ? bindingValue.hydrateBeforeCommit
    : undefined;
  const consistency = record(bindingValue)
    ? bindingValue.consistency
    : undefined;
  const contextFactoryValue = record(bindingValue)
    ? bindingValue.contextFactory
    : undefined;
  const createContext = record(contextFactoryValue)
    ? contextFactoryValue.create
    : undefined;
  if (
    !record(bindingValue) ||
    [loadPrimary, getId, getState, getVersion, applyPrimary].some(
      (method) => typeof method !== "function",
    ) ||
    (transactionOptionsValue !== undefined &&
      typeof transactionOptionsValue !== "function") ||
    (contextFactoryValue !== undefined &&
      typeof createContext !== "function") ||
    (typeof consistency !== "function" && !record(consistency)) ||
    (applyRelated !== undefined && typeof applyRelated !== "function") ||
    (hydrateBeforeCommit !== undefined &&
      typeof hydrateBeforeCommit !== "function")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Resource binding is incomplete.",
    );
  if (idsValue !== undefined && typeof idsValue !== "function")
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "ID provider must be callable.",
    );
  if (nowValue !== undefined && typeof nowValue !== "function")
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Clock provider must be callable.",
    );
  if (
    maxOutboxPayloadBytesValue !== undefined &&
    (!Number.isInteger(maxOutboxPayloadBytesValue) ||
      maxOutboxPayloadBytesValue <= 0)
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Maximum outbox payload size must be a positive integer.",
    );
  const lifecycle = Object.freeze({
    name: lifecycleName,
    definitionVersion: lifecycleValue.definitionVersion,
    states: lifecycleValue.states,
    events: lifecycleValue.events,
    history: Object.freeze({
      resourceType,
      ...(historyActor === undefined
        ? {}
        : { actor: bindMethod(historyActor, lifecycleHistory) }),
      ...(historyMetadata === undefined
        ? {}
        : { metadata: bindMethod(historyMetadata, lifecycleHistory) }),
    }),
    ...(lifecycleIdempotency === undefined
      ? {}
      : {
          idempotency: Object.freeze({
            fingerprint: bindMethod(fingerprint, lifecycleIdempotency),
          }),
        }),
    getEvent: bindMethod(getEvent, lifecycleValue),
    parseInput: bindMethod(parseInput, lifecycleValue),
  }) as unknown as typeof lifecycleValue;
  const driver = Object.freeze({
    transaction: bindMethod(driverTransaction, driverValue),
    claimIdempotency: bindMethod(claimIdempotency, driverValue),
    completeIdempotency: bindMethod(completeIdempotency, driverValue),
    insertTransition: bindMethod(insertTransition, driverValue),
    insertOutbox: bindMethod(insertOutbox, driverValue),
  }) as unknown as TransactionDriver<Transaction>;
  const binding = Object.freeze({
    loadPrimary: bindMethod(loadPrimary, bindingValue),
    getId: bindMethod(getId, bindingValue),
    getState: bindMethod(getState, bindingValue),
    getVersion: bindMethod(getVersion, bindingValue),
    applyPrimary: bindMethod(applyPrimary, bindingValue),
    consistency:
      typeof consistency === "function"
        ? bindMethod(consistency, bindingValue)
        : consistency,
    ...(transactionOptionsValue === undefined
      ? {}
      : {
          transactionOptions: bindMethod(transactionOptionsValue, bindingValue),
        }),
    ...(createContext === undefined
      ? {}
      : {
          contextFactory: Object.freeze({
            create: bindMethod(createContext, contextFactoryValue as object),
          }),
        }),
    ...(applyRelated === undefined
      ? {}
      : { applyRelated: bindMethod(applyRelated, bindingValue) }),
    ...(hydrateBeforeCommit === undefined
      ? {}
      : {
          hydrateBeforeCommit: bindMethod(hydrateBeforeCommit, bindingValue),
        }),
  }) as unknown as ResourceBinding<
    Transaction,
    Resource,
    Actor,
    Context,
    MutationMap<Events>
  >;
  const ids = (idsValue as (() => string) | undefined) ?? randomUUID;
  const now = (nowValue as (() => Date) | undefined) ?? (() => new Date());
  const maxOutboxPayloadBytes = maxOutboxPayloadBytesValue ?? 256_000;
  const staticConsistency =
    typeof binding.consistency === "function"
      ? undefined
      : snapshotConsistency(binding.consistency, "Binding");
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
  const resolveTransactionOptions = (
    operation: InterlockOperation<Actor, EventName<Schemas>>,
  ): TransactionOptions => {
    try {
      return snapshotTransactionOptions(
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

  async function normalizeEvent(
    request: SnapshotRequest<Actor>,
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
    const event = lifecycle.getEvent(request.event as string) as
      LifecycleEvent | undefined;
    if (!event)
      return {
        ok: false,
        result: {
          status: "unknown-event",
          event: request.event as string,
        } as const,
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
    request: SnapshotTransitionRequest<Actor>,
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
        const pending = settlement(evaluated);
        authorization = snapshotDecision(
          pending ? await pending : evaluated,
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
      return publicDenial("authorization", authorization.denial);
    for (const guard of event.guards ?? []) {
      let result;
      try {
        const evaluated = guard.evaluate(args);
        const pending = settlement(evaluated);
        result = snapshotDecision(
          pending ? await pending : evaluated,
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
        return publicDenial("guard", result.denial, guard.name);
    }
    return undefined;
  }

  async function assess(
    request: AssessmentRequestFor<Events, Actor>,
  ): Promise<AssessmentResult> {
    const command = snapshotAssessmentRequest<Actor>(request);
    if ("status" in command) return command;
    const normalized = await normalizeEvent(command);
    if (!normalized.ok) return normalized.result;
    const advisoryOperation = operationFor<Actor, Schemas>(command, "advisory");
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
            const pending = settlement(created);
            context = pending ? await pending : (created as Context);
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
    const command = snapshotTransitionRequest<Actor>(request);
    if ("status" in command) return command;
    const normalized = await normalizeTransition(command);
    if (!normalized.ok) return normalized.result;
    const authoritativeOperation = operationFor<Actor, Schemas>(
      command,
      "authoritative",
    );
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
            claim = snapshotIdempotencyResult(
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
              transition: snapshotDuplicateTransition(claim.transition, {
                lifecycle: lifecycle.name,
                resourceType: lifecycle.history.resourceType,
                resourceId: command.id as string,
                event: command.event as string,
                idempotencyKey: command.idempotency.key as string,
                requestFingerprint: normalized.fingerprint as string,
              }),
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
            const pending = settlement(created);
            context = pending ? await pending : (created as Context);
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
          const pending =
            projected === undefined ? undefined : settlement(projected);
          mutation = pending ? await pending : projected;
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
          const pending =
            projected === undefined ? undefined : settlement(projected);
          auditData = pending ? await pending : projected;
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
          const pending =
            projected === undefined ? undefined : settlement(projected);
          descriptors =
            projected === undefined ? [] : pending ? await pending : projected;
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
        const plannedDescriptors = descriptors.map((descriptor) =>
          snapshotOutboxDescriptor(descriptor, maxOutboxPayloadBytes),
        );
        let actorIdentity;
        try {
          const projected = lifecycle.history.actor?.(command.actor);
          const pending =
            projected === undefined ? undefined : settlement(projected);
          actorIdentity =
            projected === undefined ? {} : pending ? await pending : projected;
        } catch (error) {
          throw operational(
            "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
            "History actor projection failed.",
            error,
          );
        }
        assertClock();
        const { actorType, actorId } = snapshotActorIdentity(actorIdentity);
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
          const pending =
            projected === undefined ? undefined : settlement(projected);
          metadata = pending ? await pending : projected;
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
        let applied;
        try {
          applied = snapshotPrimaryResult<Resource>(
            await binding.applyPrimary(transaction, {
              resource,
              fromState,
              toState: normalized.event.to,
              expectedVersion,
              nextVersion,
              operation: writeOperation,
            }),
          );
        } catch (error) {
          throw operational(
            "INTERLOCK_PERSISTENCE_FAILED",
            "Primary resource update failed.",
            error,
          );
        }
        if (applied.status === "not-found") rollback({ status: "not-found" });
        if (applied.status === "conflict") {
          rollback({
            status: "conflict",
            expected: normalized.expectedVersion,
            ...(applied.actual === undefined ? {} : { actual: applied.actual }),
          });
        }
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
        return snapshotConsistency(
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
