import { InterlockError } from "./errors.js";
import type {
  Decision,
  InputSchema,
  JsonValue,
  InterlockOperation,
  ParseResult,
  Schema,
  StandardSchema,
} from "./types.js";

/** Immutable callback envelope containing application-owned transition values. */
export interface ProjectionArgs<Resource, Actor, Context, Input> {
  readonly resource: Resource;
  readonly actor: Actor;
  readonly context: Context;
  readonly input: Input;
  readonly operation: InterlockOperation<Actor>;
  readonly transitionId: string;
  readonly clock: { readonly occurredAt: Date };
}

type ProjectionResult<Value> = Value | PromiseLike<Value>;

export type AssessmentArgs<Resource, Actor, Context, Input> = Pick<
  ProjectionArgs<Resource, Actor, Context, Input>,
  "resource" | "actor" | "context" | "input"
>;

export type AnySchema = Schema<never, unknown> | Schema<unknown, unknown>;

export const noInput: InputSchema<undefined, undefined> = {
  parse: (input) =>
    input === undefined
      ? { success: true, value: undefined }
      : {
          success: false,
          issues: [
            {
              path: ["input"],
              code: "UNEXPECTED_INPUT",
              message: "This event does not accept input.",
            },
          ],
        },
};

export type SubmittedInputOf<SchemaType> =
  SchemaType extends InputSchema<infer Submitted, unknown>
    ? Submitted
    : SchemaType extends {
          readonly "~standard": {
            readonly types?: { readonly input: infer Submitted };
          };
        }
      ? Submitted
      : undefined;

export type ParsedInputOf<SchemaType> =
  SchemaType extends InputSchema<unknown, infer Parsed>
    ? Parsed
    : SchemaType extends {
          readonly "~standard": {
            readonly types?: { readonly output: infer Parsed };
          };
        }
      ? Parsed
      : undefined;

/** One named, sequential policy check evaluated after authorization. */
export interface GuardDefinition<Resource, Actor, Context, Parsed> {
  /** Stable diagnostic name included in public guard denials. */
  name: string;
  /** Returns a synchronous or asynchronous decision without performing writes. */
  evaluate(
    args: AssessmentArgs<Resource, Actor, Context, Parsed>,
  ): Decision | Promise<Decision>;
}

type EventCore<Resource, Actor, Context, Parsed> = {
  /** States from which the event may run. */
  from: readonly string[];
  /** State committed by a successful transition. */
  to: string;
  /** Optional policy check; `transition()` repeats it authoritatively. */
  authorize?: (
    args: AssessmentArgs<Resource, Actor, Context, Parsed>,
  ) => Decision | Promise<Decision>;
  /** Ordered checks that stop at the first denial. */
  guards?: readonly GuardDefinition<Resource, Actor, Context, Parsed>[];
  /** Produces detached JSON history data before the first write. */
  audit?: (
    args: ProjectionArgs<Resource, Actor, Context, Parsed>,
  ) => ProjectionResult<JsonValue>;
  /** Produces detached outbox descriptors before the first write. */
  outbox?: (
    args: ProjectionArgs<Resource, Actor, Context, Parsed>,
  ) => ProjectionResult<
    readonly { topic: string; key?: string; payload: JsonValue }[]
  >;
};

type MutationProjection<Resource, Actor, Context, Parsed, Mutation> = [
  Mutation,
] extends [undefined]
  ? { mutate?: undefined }
  : {
      /** Plans the event-correlated application mutation before writes begin. */
      mutate(
        args: ProjectionArgs<Resource, Actor, Context, Parsed>,
      ): ProjectionResult<Mutation>;
    };

/** Defines one typed lifecycle edge and its synchronous or asynchronous plan. */
export type EventDefinition<
  Resource,
  Actor,
  Context,
  Mutation,
  SchemaType extends AnySchema | undefined = undefined,
> = EventCore<Resource, Actor, Context, ParsedInputOf<SchemaType>> &
  MutationProjection<
    Resource,
    Actor,
    Context,
    ParsedInputOf<SchemaType>,
    Mutation
  > &
  (SchemaType extends AnySchema
    ? { input: SchemaType }
    : { input?: undefined });

export type EventSchemaMap = Record<string, AnySchema | undefined>;
export type EventMap<
  Resource,
  Actor,
  Context,
  Schemas extends EventSchemaMap = EventSchemaMap,
  Mutations extends { [Event in keyof Schemas]: unknown } = {
    [Event in keyof Schemas]: unknown;
  },
> = {
  readonly [Event in keyof Schemas]: EventDefinition<
    Resource,
    Actor,
    Context,
    Mutations[Event],
    Schemas[Event]
  >;
};

export interface LifecycleDefinition<
  Resource,
  Actor,
  Context,
  Schemas extends EventSchemaMap,
  Mutations extends { [Event in keyof Schemas]: unknown },
> {
  name: string;
  definitionVersion?: string;
  states: readonly string[];
  events: EventMap<Resource, Actor, Context, Schemas, Mutations>;
  history: {
    resourceType: string;
    /** Projects optional actor identity copied into transition history. */
    actor?: (
      actor: Actor,
    ) => ProjectionResult<{ actorType?: string; actorId?: string }>;
    /** Projects optional detached JSON metadata before writes begin. */
    metadata?: (args: {
      readonly request: {
        readonly resourceId: string;
        readonly event: string;
        readonly metadata?: JsonValue;
      };
      readonly actor: Actor;
      readonly resource: Resource;
    }) => ProjectionResult<JsonValue>;
  };
  idempotency?: IdempotencyConfiguration<Actor, Schemas>;
}

export type FingerprintArgs<Actor, Schemas extends EventSchemaMap> = {
  [Event in Extract<keyof Schemas, string>]: {
    readonly lifecycle: string;
    readonly resourceId: string;
    readonly event: Event;
    readonly parsedInput: ParsedInputOf<Schemas[Event]>;
    readonly actor: Actor;
    readonly expectedVersion: string;
  };
}[Extract<keyof Schemas, string>];

export type IdempotencyConfiguration<Actor, Schemas extends EventSchemaMap> = {
  /** Returns a stable, non-empty fingerprint for the normalized event command. */
  fingerprint(args: FingerprintArgs<Actor, Schemas>): string;
};

/** A validated lifecycle definition with input parsing and event lookup. */
export type Lifecycle<
  Resource,
  Actor,
  Context,
  Schemas extends EventSchemaMap,
  Mutations extends { [Event in keyof Schemas]: unknown },
  Events extends Record<string, unknown>,
  Idempotency = IdempotencyConfiguration<Actor, Schemas> | undefined,
> = Omit<
  LifecycleDefinition<Resource, Actor, Context, Schemas, Mutations>,
  "events" | "idempotency"
> &
  ([Idempotency] extends [undefined]
    ? { readonly idempotency?: undefined }
    : { readonly idempotency: Idempotency }) & {
    events: Events;
    getEvent(
      name: string,
    ):
      | EventMap<Resource, Actor, Context, Schemas, Mutations>[Extract<
          keyof Schemas,
          string
        >]
      | undefined;
    parseInput(
      event: EventMap<Resource, Actor, Context, Schemas, Mutations>[Extract<
        keyof Schemas,
        string
      >],
      input: unknown,
    ): Promise<ParseResult<unknown>>;
  };

type LifecycleShape = {
  readonly states: readonly string[];
  readonly events: Record<string, unknown>;
};

type StateConstrainedEvents<Definition extends LifecycleShape> = {
  readonly events: {
    readonly [
      Event in keyof Definition["events"]
    ]: Definition["events"][Event] & {
      readonly from: readonly Definition["states"][number][];
      readonly to: Definition["states"][number];
    };
  };
};

type DefinitionIdempotency<
  Actor,
  Schemas extends EventSchemaMap,
  Definition extends LifecycleShape,
> = Definition extends { readonly idempotency: infer Idempotency }
  ? Idempotency & IdempotencyConfiguration<Actor, Schemas>
  : undefined;

function normalizePath(
  path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined,
): Array<string | number> {
  return (path ?? []).map((part) => {
    const key = typeof part === "object" ? part.key : part;
    return typeof key === "number" ? key : String(key);
  });
}

async function parseSchema(
  schema: AnySchema | undefined,
  input: unknown,
): Promise<ParseResult<unknown>> {
  if (schema === undefined) {
    return input === undefined
      ? { success: true, value: undefined }
      : {
          success: false,
          issues: [
            {
              path: ["input"],
              code: "UNEXPECTED_INPUT",
              message: "This event does not accept input.",
            },
          ],
        };
  }
  if ("parse" in schema) {
    const result: unknown = await (
      schema as InputSchema<unknown, unknown>
    ).parse(input);
    return normalizeParseResult(result);
  }
  const result: unknown = await (schema as StandardSchema<unknown, unknown>)[
    "~standard"
  ].validate(input);
  if (!result || typeof result !== "object")
    protocol("Standard Schema returned an invalid result.");
  const issuesValue = "issues" in result ? result.issues : undefined;
  if (issuesValue !== undefined) {
    if (!Array.isArray(issuesValue))
      protocol("Standard Schema issues must be an array.");
    return {
      success: false,
      issues: issuesValue.map((issue) => {
        if (!issue || typeof issue !== "object")
          protocol("Standard Schema returned a malformed issue.");
        const message = "message" in issue ? issue.message : undefined;
        const path = "path" in issue ? issue.path : undefined;
        if (
          typeof message !== "string" ||
          (path !== undefined && !Array.isArray(path))
        )
          protocol("Standard Schema returned a malformed issue.");
        return {
          path: normalizePath(
            path as
              ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined,
          ),
          code: "INVALID_INPUT",
          message,
        };
      }),
    };
  }
  const hasValue = "value" in result;
  const parsedValue = hasValue ? result.value : undefined;
  if (!hasValue)
    protocol("Standard Schema success result must contain a value.");
  return { success: true, value: parsedValue };
}

function invalid(message: string): never {
  throw new InterlockError("INTERLOCK_DEFINITION_INVALID", message);
}

function protocol(message: string): never {
  throw new InterlockError("INTERLOCK_DEFINITION_PROTOCOL_VIOLATION", message);
}

function normalizeParseResult(value: unknown): ParseResult<unknown> {
  if (!value || typeof value !== "object" || !("success" in value))
    protocol("Input parser returned an invalid result.");
  const success = value.success;
  if (success === true) {
    const hasValue = "value" in value;
    const parsedValue = hasValue ? value.value : undefined;
    if (!hasValue)
      protocol("Input parser success result must contain a value.");
    return { success: true, value: parsedValue };
  }
  const issuesValue = "issues" in value ? value.issues : undefined;
  if (success !== false || !Array.isArray(issuesValue))
    protocol("Input parser failure result must contain an issues array.");
  return {
    success: false,
    issues: issuesValue.map((issue) => {
      if (!issue || typeof issue !== "object")
        protocol("Input parser returned a malformed issue.");
      const code = "code" in issue ? issue.code : undefined;
      const message = "message" in issue ? issue.message : undefined;
      const path = "path" in issue ? issue.path : undefined;
      if (
        typeof code !== "string" ||
        typeof message !== "string" ||
        !Array.isArray(path) ||
        path.some(
          (part: unknown) =>
            typeof part !== "string" && typeof part !== "number",
        )
      )
        protocol("Input parser returned a malformed issue.");
      return {
        path: [...path],
        code,
        message,
      };
    }),
  };
}

function snapshotSchema(schema: AnySchema | undefined): AnySchema | undefined {
  if (!schema) return undefined;
  if ("parse" in schema) {
    const parse = (schema as InputSchema<unknown, unknown>).parse.bind(schema);
    return Object.freeze({ parse });
  }
  const standard = (schema as StandardSchema<unknown, unknown>)["~standard"];
  return Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      validate: standard.validate.bind(standard),
    }),
  });
}

export type EventMutation<Event> = Event extends {
  mutate: (...args: never[]) => infer Result;
}
  ? Awaited<Result>
  : undefined;

export type MutationMap<Events> = {
  [Event in keyof Events]: EventMutation<Events[Event]>;
};

export interface EventBuilder<Resource, Actor, Context> {
  <
    SchemaType extends AnySchema,
    Mutation,
    const Definition extends EventCore<
      Resource,
      Actor,
      Context,
      ParsedInputOf<SchemaType>
    > & {
      mutate(
        args: ProjectionArgs<
          Resource,
          Actor,
          Context,
          ParsedInputOf<SchemaType>
        >,
      ): ProjectionResult<Mutation>;
    },
  >(
    schema: SchemaType,
    definition: Definition,
  ): Definition & { readonly input: SchemaType };
  <
    SchemaType extends AnySchema,
    const Definition extends EventCore<
      Resource,
      Actor,
      Context,
      ParsedInputOf<SchemaType>
    > & { mutate?: undefined },
  >(
    schema: SchemaType,
    definition: Definition,
  ): Definition & {
    readonly input: SchemaType;
    readonly mutate: () => undefined;
  };
  <
    Mutation,
    const Definition extends EventCore<Resource, Actor, Context, undefined> & {
      mutate(
        args: ProjectionArgs<Resource, Actor, Context, undefined>,
      ): ProjectionResult<Mutation>;
    },
  >(
    definition: Definition,
  ): Definition;
  <
    const Definition extends EventCore<Resource, Actor, Context, undefined> & {
      mutate?: undefined;
    },
  >(
    definition: Definition,
  ): Definition & { readonly mutate: () => undefined };
}

/** Creates an event builder that preserves event-specific input and mutation types. */
export function defineEvent<
  Resource,
  Actor = undefined,
  Context = undefined,
>(): EventBuilder<Resource, Actor, Context> {
  return ((schemaOrDefinition: AnySchema | object, definition?: object) => {
    const event =
      definition === undefined
        ? schemaOrDefinition
        : { ...definition, input: schemaOrDefinition };
    return "mutate" in event ? event : { ...event, mutate: () => undefined };
  }) as EventBuilder<Resource, Actor, Context>;
}

/** Validates and snapshots a lifecycle definition into an immutable runtime API. */
export function defineLifecycle<
  Resource,
  Actor = undefined,
  Context = undefined,
>(): <
  const Schemas extends EventSchemaMap,
  const Mutations extends { [Event in keyof Schemas]: unknown },
  const Definition extends LifecycleShape,
>(
  definition: LifecycleDefinition<
    Resource,
    Actor,
    Context,
    Schemas,
    Mutations
  > &
    Definition &
    StateConstrainedEvents<Definition>,
) => Lifecycle<
  Resource,
  Actor,
  Context,
  Schemas,
  Mutations,
  Definition["events"],
  DefinitionIdempotency<Actor, Schemas, Definition>
>;
export function defineLifecycle<
  Resource,
  Actor,
  Context,
  const Schemas extends EventSchemaMap,
  const Mutations extends { [Event in keyof Schemas]: unknown },
  const Definition extends LifecycleShape,
>(
  definition: LifecycleDefinition<
    Resource,
    Actor,
    Context,
    Schemas,
    Mutations
  > &
    Definition &
    StateConstrainedEvents<Definition>,
): Lifecycle<
  Resource,
  Actor,
  Context,
  Schemas,
  Mutations,
  Definition["events"],
  DefinitionIdempotency<Actor, Schemas, Definition>
>;
export function defineLifecycle<
  Resource,
  Actor,
  Context,
  const Schemas extends EventSchemaMap,
  const Mutations extends { [Event in keyof Schemas]: unknown },
  const Definition extends LifecycleShape,
>(
  definition?: LifecycleDefinition<
    Resource,
    Actor,
    Context,
    Schemas,
    Mutations
  > &
    Definition,
):
  | Lifecycle<
      Resource,
      Actor,
      Context,
      Schemas,
      Mutations,
      Definition["events"],
      DefinitionIdempotency<Actor, Schemas, Definition>
    >
  | ((
      value: LifecycleDefinition<Resource, Actor, Context, Schemas, Mutations> &
        Definition &
        StateConstrainedEvents<Definition>,
    ) => Lifecycle<
      Resource,
      Actor,
      Context,
      Schemas,
      Mutations,
      Definition["events"],
      DefinitionIdempotency<Actor, Schemas, Definition>
    >) {
  if (definition === undefined)
    return ((value: unknown) => defineLifecycle(value as never)) as never;
  if (!definition || typeof definition !== "object")
    invalid("Lifecycle definition is invalid.");
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.name))
    invalid("Lifecycle name is invalid.");
  if (!Array.isArray(definition.states))
    invalid("Lifecycle states must be an array.");
  const states = new Set(definition.states);
  if (
    definition.states.some((state) => typeof state !== "string" || !state) ||
    states.size !== definition.states.length ||
    states.size === 0
  )
    invalid("Lifecycle states must be unique and non-empty.");
  if (
    !definition.history ||
    typeof definition.history !== "object" ||
    typeof definition.history.resourceType !== "string" ||
    !definition.history.resourceType
  )
    invalid("History resource type must be a non-empty string.");
  if (
    definition.definitionVersion !== undefined &&
    (typeof definition.definitionVersion !== "string" ||
      !definition.definitionVersion)
  )
    invalid("Definition version must be a non-empty string.");
  if (
    (definition.history.actor !== undefined &&
      typeof definition.history.actor !== "function") ||
    (definition.history.metadata !== undefined &&
      typeof definition.history.metadata !== "function") ||
    (definition.idempotency !== undefined &&
      (!definition.idempotency ||
        typeof definition.idempotency !== "object" ||
        typeof definition.idempotency.fingerprint !== "function"))
  )
    invalid("Lifecycle projections must be callable.");
  if (!definition.events || typeof definition.events !== "object")
    invalid("Lifecycle events must be an object.");

  const eventEntries = Object.entries(definition.events) as Array<
    [
      string,
      {
        from: readonly string[];
        to: string;
        input?: AnySchema;
        authorize?: unknown;
        mutate?: unknown;
        audit?: unknown;
        outbox?: unknown;
        guards?: readonly { name: string; evaluate?: unknown }[];
      },
    ]
  >;
  const events = Object.fromEntries(
    eventEntries.map(([name, event]) => {
      if (!event || typeof event !== "object")
        invalid(`Event ${name} is invalid.`);
      if (!name || name.length > 128)
        invalid("Event names must contain 1 to 128 characters.");
      if (!Array.isArray(event.from) || event.from.length === 0)
        invalid(`Event ${name} must have at least one source state.`);
      if (new Set(event.from).size !== event.from.length)
        invalid(`Event ${name} has duplicate source states.`);
      if (event.from.some((state) => !states.has(state)))
        invalid(`Event ${name} has an unknown source state.`);
      if (!states.has(event.to))
        invalid(`Event ${name} has an unknown target state.`);
      if (event.from.includes(event.to))
        invalid(`Event ${name} cannot transition a state to itself.`);
      if (event.guards !== undefined && !Array.isArray(event.guards))
        invalid(`Event ${name} guards must be an array.`);
      if (event.guards?.some((guard) => !guard || typeof guard !== "object"))
        invalid(`Event ${name} has invalid guards.`);
      const guards = event.guards?.map((guard) => guard.name) ?? [];
      if (guards.some((guard) => typeof guard !== "string" || !guard))
        invalid(`Event ${name} has an empty or invalid guard name.`);
      if (new Set(guards).size !== guards.length)
        invalid(`Event ${name} has duplicate guard names.`);
      if (
        (event.mutate !== undefined && typeof event.mutate !== "function") ||
        (event.authorize !== undefined &&
          typeof event.authorize !== "function") ||
        (event.audit !== undefined && typeof event.audit !== "function") ||
        (event.outbox !== undefined && typeof event.outbox !== "function") ||
        event.guards?.some((guard) => typeof guard.evaluate !== "function")
      )
        invalid(`Event ${name} has invalid callbacks.`);
      if (event.input !== undefined) {
        if (!event.input || typeof event.input !== "object")
          invalid(`Event ${name} has an unsupported input schema.`);
        if ("parse" in event.input) {
          if (typeof event.input.parse !== "function")
            invalid(`Event ${name} has an invalid input parser.`);
        } else if ("~standard" in event.input) {
          const standard = event.input["~standard"];
          if (
            !standard ||
            typeof standard !== "object" ||
            standard.version !== 1 ||
            typeof standard.validate !== "function"
          )
            invalid(
              `Event ${name} has an unsupported Standard Schema adapter.`,
            );
        } else invalid(`Event ${name} has an unsupported input schema.`);
      }
      return [
        name,
        Object.freeze({
          ...event,
          from: Object.freeze([...event.from]),
          ...(event.input === undefined
            ? {}
            : { input: snapshotSchema(event.input) }),
          ...(event.guards
            ? {
                guards: Object.freeze(
                  event.guards.map((guard) => Object.freeze({ ...guard })),
                ),
              }
            : {}),
        }),
      ];
    }),
  ) as Definition["events"];

  const lifecycle = {
    ...definition,
    states: Object.freeze([...definition.states]),
    events: Object.freeze(events),
    history: Object.freeze({ ...definition.history }),
    ...(definition.idempotency
      ? { idempotency: Object.freeze({ ...definition.idempotency }) }
      : {}),
    getEvent: (name: string) =>
      Object.hasOwn(events, name)
        ? (events[name as keyof Definition["events"]] as unknown as EventMap<
            Resource,
            Actor,
            Context,
            Schemas,
            Mutations
          >[Extract<keyof Schemas, string>])
        : undefined,
    parseInput: (
      event: EventMap<Resource, Actor, Context, Schemas, Mutations>[Extract<
        keyof Schemas,
        string
      >],
      input: unknown,
    ) => parseSchema(event.input, input),
  } as unknown as Lifecycle<
    Resource,
    Actor,
    Context,
    Schemas,
    Mutations,
    Definition["events"],
    DefinitionIdempotency<Actor, Schemas, Definition>
  >;
  return Object.freeze(lifecycle) as Lifecycle<
    Resource,
    Actor,
    Context,
    Schemas,
    Mutations,
    Definition["events"],
    DefinitionIdempotency<Actor, Schemas, Definition>
  >;
}
