import type { EventSchemaMap, SubmittedInputOf } from "./lifecycle.js";
import { freezeJson, record, snapshotJson } from "./protocol.js";
import type {
  AssessmentResult,
  InterlockOperation,
  JsonValue,
  TransitionResult,
} from "./types.js";

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

export interface SnapshotRequest<Actor> {
  readonly id: string;
  readonly actor: Actor;
  readonly metadata?: JsonValue;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly event: string;
  readonly input?: unknown;
}

export interface SnapshotTransitionRequest<
  Actor,
> extends SnapshotRequest<Actor> {
  readonly expectedVersion: unknown;
  readonly idempotency?: { readonly key: string };
}

type RequestFailure =
  | Extract<AssessmentResult, { status: "invalid-input" }>
  | Extract<TransitionResult<never>, { status: "invalid-input" }>;

function invalid(path: string, code: string, message: string): RequestFailure {
  return { status: "invalid-input", issues: [{ path: [path], code, message }] };
}

function snapshotCommon<Actor>(
  value: unknown,
): SnapshotRequest<Actor> | RequestFailure {
  if (!record(value))
    return invalid("request", "INVALID_REQUEST", "Request must be an object.");
  const id = value.id;
  const event = value.event;
  const actor = value.actor as Actor;
  const input = value.input;
  const metadataValue = value.metadata;
  const correlationId = value.correlationId;
  const causationId = value.causationId;
  if (
    correlationId !== undefined &&
    (typeof correlationId !== "string" || correlationId.length === 0)
  )
    return invalid(
      "correlationId",
      "INVALID_CORRELATION_ID",
      "correlationId must be a non-empty string.",
    );
  if (
    causationId !== undefined &&
    (typeof causationId !== "string" || causationId.length === 0)
  )
    return invalid(
      "causationId",
      "INVALID_CAUSATION_ID",
      "causationId must be a non-empty string.",
    );
  const metadata =
    metadataValue === undefined
      ? undefined
      : freezeJson(snapshotJson(metadataValue, "Request metadata"));
  return Object.freeze({
    id: id as string,
    event: event as string,
    actor,
    input,
    ...(metadata === undefined ? {} : { metadata }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(causationId === undefined ? {} : { causationId }),
  });
}

export function snapshotAssessmentRequest<Actor>(
  value: unknown,
): SnapshotRequest<Actor> | RequestFailure {
  return snapshotCommon<Actor>(value);
}

export function snapshotTransitionRequest<Actor>(
  value: unknown,
): SnapshotTransitionRequest<Actor> | RequestFailure {
  if (!record(value))
    return invalid("request", "INVALID_REQUEST", "Request must be an object.");
  const expectedVersion = value.expectedVersion;
  const idempotencyValue = value.idempotency;
  const key = record(idempotencyValue) ? idempotencyValue.key : undefined;
  const common = snapshotCommon<Actor>(value);
  if ("status" in common) return common;
  return Object.freeze({
    ...common,
    expectedVersion,
    ...(idempotencyValue === undefined
      ? {}
      : { idempotency: Object.freeze({ key: key as string }) }),
  });
}

export function operationFor<Actor, Schemas extends EventSchemaMap>(
  request: SnapshotRequest<Actor>,
  mode: "advisory" | "authoritative",
): InterlockOperation<Actor, Extract<keyof Schemas, string>> {
  return Object.freeze({
    mode,
    id: request.id,
    event: request.event as Extract<keyof Schemas, string>,
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
