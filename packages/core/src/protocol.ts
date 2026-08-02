import { InterlockError, isInterlockError } from "./errors.js";
import { assertJsonValue, snapshotJsonValue } from "./json.js";
import type {
  JsonValue,
  PublicDenial,
  RelatedDataConsistency,
  TransactionOptions,
  TransitionRecord,
  VersionToken,
} from "./types.js";
import { parseVersionToken } from "./version.js";

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function operational(
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

export function snapshotJson(value: unknown, label: string): JsonValue {
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

export function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  for (const item of Array.isArray(value) ? value : Object.values(value))
    freezeJson(item);
  return Object.freeze(value);
}

const consistencyStrategies = new Set<RelatedDataConsistency["strategy"]>([
  "none",
  "row-locking",
  "aggregate-version",
  "dependency-version",
  "serializable",
  "database-constraint",
  "custom",
]);

export function snapshotConsistency(
  value: unknown,
  label: string,
): RelatedDataConsistency {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      `${label} consistency declaration is invalid.`,
    );
  const strategy = value.strategy;
  const notes = value.notes;
  if (
    typeof strategy !== "string" ||
    !consistencyStrategies.has(
      strategy as RelatedDataConsistency["strategy"],
    ) ||
    !nonempty(notes)
  )
    throw new InterlockError(
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      `${label} consistency declaration is invalid.`,
    );
  return Object.freeze({
    strategy: strategy as RelatedDataConsistency["strategy"],
    notes,
  });
}

export function snapshotTransactionOptions(
  value: unknown,
  label: string,
): TransactionOptions {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      `${label} transaction options must be an object.`,
    );
  const isolation = value.isolation;
  const readOnly = value.readOnly;
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
  if (readOnly !== undefined && typeof readOnly !== "boolean")
    throw new InterlockError(
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      `${label} read-only option is invalid.`,
    );
  return Object.freeze({
    ...(isolation === undefined ? {} : { isolation }),
    ...(readOnly === undefined ? {} : { readOnly }),
  });
}

export function snapshotDecision(value: unknown, label: string) {
  if (value === true) return Object.freeze({ allowed: true } as const);
  if (value === false)
    return Object.freeze({
      allowed: false,
      denial: Object.freeze({ code: "DENIED" }),
    } as const);
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      `${label} returned an invalid decision.`,
    );
  const allowed = value.allowed;
  if (allowed === true) return Object.freeze({ allowed: true } as const);
  const denialValue = value.denial;
  if (allowed !== false || !record(denialValue))
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      `${label} returned an invalid decision.`,
    );
  const code = denialValue.code;
  const message = denialValue.message;
  const publicDetailsValue = denialValue.publicDetails;
  const privateMessage = denialValue.privateMessage;
  const privateDetails = denialValue.privateDetails;
  if (
    !nonempty(code) ||
    (message !== undefined && typeof message !== "string") ||
    (privateMessage !== undefined && typeof privateMessage !== "string")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      `${label} returned an invalid denial.`,
    );
  let publicDetails: JsonValue | undefined;
  try {
    if (publicDetailsValue !== undefined)
      publicDetails = snapshotJsonValue(publicDetailsValue);
    if (privateDetails !== undefined) assertJsonValue(privateDetails);
  } catch (error) {
    throw operational(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      `${label} returned invalid denial details.`,
      error,
    );
  }
  return Object.freeze({
    allowed: false,
    denial: Object.freeze({
      code,
      ...(message === undefined ? {} : { message }),
      ...(publicDetails === undefined ? {} : { publicDetails }),
    }),
  } as const);
}

export function publicDenial(
  source: "authorization" | "guard",
  denial: { code: string; message?: string; publicDetails?: JsonValue },
  rule?: string,
): PublicDenial {
  const code = denial.code;
  const message = denial.message;
  const publicDetails = denial.publicDetails;
  return {
    source,
    ...(rule === undefined ? {} : { rule }),
    code,
    ...(message === undefined ? {} : { message }),
    ...(publicDetails === undefined ? {} : { publicDetails }),
  };
}

export function snapshotOutboxDescriptor(
  value: unknown,
  maxPayloadBytes: number,
) {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      "Outbox descriptors require a topic and optional string key.",
    );
  const topic = value.topic;
  const key = value.key;
  const payloadValue = value.payload;
  if (
    typeof topic !== "string" ||
    topic.length === 0 ||
    (key !== undefined && typeof key !== "string")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      "Outbox descriptors require a topic and optional string key.",
    );
  const payload = snapshotJson(payloadValue, "Outbox payload");
  if (Buffer.byteLength(JSON.stringify(payload)) > maxPayloadBytes)
    throw new InterlockError(
      "INTERLOCK_SERIALIZATION_FAILED",
      "Outbox payload exceeds the configured limit.",
    );
  return Object.freeze({
    topic,
    ...(key === undefined ? {} : { key }),
    payload,
  });
}

export function snapshotActorIdentity(value: unknown) {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      "History actor projection must return an object.",
    );
  const actorType = value.actorType;
  const actorId = value.actorId;
  if (
    (actorType !== undefined && typeof actorType !== "string") ||
    (actorId !== undefined && typeof actorId !== "string")
  )
    throw new InterlockError(
      "INTERLOCK_DEFINITION_PROTOCOL_VIOLATION",
      "History actor projection must return string identity fields.",
    );
  return Object.freeze({
    ...(actorType === undefined ? {} : { actorType }),
    ...(actorId === undefined ? {} : { actorId }),
  });
}

export function snapshotIdempotencyResult(value: unknown) {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
      "Driver returned an invalid idempotency result.",
    );
  const status = value.status;
  if (status === "claimed" || status === "conflict")
    return Object.freeze({ status } as const);
  const transition = value.transition;
  if (status === "duplicate" && transition !== undefined)
    return Object.freeze({ status, transition } as const);
  throw new InterlockError(
    "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
    "Driver returned an invalid idempotency result.",
  );
}

export function snapshotDuplicateTransition(
  value: unknown,
  expected: {
    lifecycle: string;
    resourceType: string;
    resourceId: string;
    event: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
): TransitionRecord {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
      "Driver returned a malformed duplicate transition.",
    );
  const id = value.id;
  const lifecycle = value.lifecycle;
  const resourceType = value.resourceType;
  const resourceId = value.resourceId;
  const event = value.event;
  const fromState = value.fromState;
  const toState = value.toState;
  const previousVersion = value.previousVersion;
  const nextVersion = value.nextVersion;
  const occurredAt = value.occurredAt;
  const actorType = value.actorType;
  const actorId = value.actorId;
  const auditDataValue = value.auditData;
  const metadataValue = value.metadata;
  const correlationId = value.correlationId;
  const causationId = value.causationId;
  const idempotencyKey = value.idempotencyKey;
  const requestFingerprint = value.requestFingerprint;
  const definitionVersion = value.definitionVersion;
  const previous = parseVersionToken(previousVersion);
  const next = parseVersionToken(nextVersion);
  let occurredTime = Number.NaN;
  if (occurredAt instanceof Date)
    occurredTime = Date.prototype.getTime.call(occurredAt);
  if (
    lifecycle !== expected.lifecycle ||
    resourceType !== expected.resourceType ||
    resourceId !== expected.resourceId ||
    event !== expected.event ||
    idempotencyKey !== expected.idempotencyKey ||
    requestFingerprint !== expected.requestFingerprint ||
    !nonempty(id) ||
    !nonempty(fromState) ||
    !nonempty(toState) ||
    !previous.success ||
    !next.success ||
    BigInt(next.value) !== BigInt(previous.value) + 1n ||
    !Number.isFinite(occurredTime)
  )
    throw new InterlockError(
      "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
      "Driver returned an unrelated or malformed duplicate transition.",
    );
  for (const [field, fieldValue] of [
    ["actorType", actorType],
    ["actorId", actorId],
    ["correlationId", correlationId],
    ["causationId", causationId],
    ["definitionVersion", definitionVersion],
  ] as const)
    if (fieldValue !== undefined && typeof fieldValue !== "string")
      throw new InterlockError(
        "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
        `Driver returned an invalid duplicate ${field}.`,
      );
  let auditData: JsonValue | undefined;
  let metadata: JsonValue | undefined;
  try {
    if (auditDataValue !== undefined)
      auditData = snapshotJsonValue(auditDataValue);
    if (metadataValue !== undefined)
      metadata = snapshotJsonValue(metadataValue);
  } catch (cause) {
    throw new InterlockError(
      "INTERLOCK_DRIVER_PROTOCOL_VIOLATION",
      "Driver returned invalid duplicate JSON data.",
      { cause },
    );
  }
  const snapshotActorType = actorType as string | undefined;
  const snapshotActorId = actorId as string | undefined;
  const snapshotCorrelationId = correlationId as string | undefined;
  const snapshotCausationId = causationId as string | undefined;
  const snapshotDefinitionVersion = definitionVersion as string | undefined;
  return Object.freeze({
    id,
    lifecycle,
    resourceType,
    resourceId,
    event,
    fromState,
    toState,
    previousVersion: previous.value,
    nextVersion: next.value,
    occurredAt: new Date(occurredTime),
    ...(snapshotActorType === undefined
      ? {}
      : { actorType: snapshotActorType }),
    ...(snapshotActorId === undefined ? {} : { actorId: snapshotActorId }),
    ...(auditData === undefined ? {} : { auditData }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(snapshotCorrelationId === undefined
      ? {}
      : { correlationId: snapshotCorrelationId }),
    ...(snapshotCausationId === undefined
      ? {}
      : { causationId: snapshotCausationId }),
    idempotencyKey,
    requestFingerprint,
    ...(snapshotDefinitionVersion === undefined
      ? {}
      : { definitionVersion: snapshotDefinitionVersion }),
  });
}

export type PrimaryResult<Resource> =
  | { status: "applied"; resource: Resource }
  | { status: "conflict"; actual?: { state: string; version: VersionToken } }
  | { status: "not-found" };

export function snapshotPrimaryResult<Resource>(
  value: unknown,
): PrimaryResult<Resource> {
  if (!record(value))
    throw new InterlockError(
      "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
      "Binding returned an invalid primary update result.",
    );
  const status = value.status;
  if (status === "not-found") return Object.freeze({ status });
  if (status === "applied") {
    const hasResource = "resource" in value;
    const resource = hasResource ? value.resource : undefined;
    if (!hasResource)
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        "Binding returned an unknown primary update result.",
      );
    return Object.freeze({ status, resource: resource as Resource });
  }
  if (status === "conflict") {
    const actualValue = value.actual;
    if (actualValue === undefined) return Object.freeze({ status });
    if (!record(actualValue))
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        "Binding returned an invalid conflict snapshot.",
      );
    const state = actualValue.state;
    const versionValue = actualValue.version;
    const version = parseVersionToken(versionValue);
    if (!nonempty(state) || !version.success)
      throw new InterlockError(
        "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
        "Binding returned an invalid conflict snapshot.",
      );
    return Object.freeze({
      status,
      actual: Object.freeze({ state, version: version.value }),
    });
  }
  throw new InterlockError(
    "INTERLOCK_BINDING_PROTOCOL_VIOLATION",
    "Binding returned an unknown primary update result.",
  );
}
