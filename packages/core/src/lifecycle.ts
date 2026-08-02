import { InterlockError } from "./errors.js";
import type {
  Decision,
  InputSchema,
  JsonValue,
  ParseResult,
  Schema,
  StandardSchema,
} from "./types.js";

export interface ProjectionArgs<Resource, Actor, Context, Input> {
  resource: Resource;
  actor: Actor;
  context: Context;
  input: Input;
  transitionId: string;
  clock: { occurredAt: Date };
}

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

type EventCore<Resource, Actor, Context, Mutation, Parsed> = {
  from: readonly string[];
  to: string;
  authorize?: (
    args: AssessmentArgs<Resource, Actor, Context, Parsed>,
  ) => Decision | Promise<Decision>;
  guards?: readonly {
    name: string;
    evaluate(
      args: AssessmentArgs<Resource, Actor, Context, Parsed>,
    ): Decision | Promise<Decision>;
  }[];
  mutate(args: ProjectionArgs<Resource, Actor, Context, Parsed>): Mutation;
  audit?: (args: ProjectionArgs<Resource, Actor, Context, Parsed>) => JsonValue;
  outbox?: (
    args: ProjectionArgs<Resource, Actor, Context, Parsed>,
  ) => readonly { topic: string; key?: string; payload: JsonValue }[];
};

export type EventDefinition<
  Resource,
  Actor,
  Context,
  Mutation,
  SchemaType extends AnySchema | undefined = undefined,
> = EventCore<Resource, Actor, Context, Mutation, ParsedInputOf<SchemaType>> &
  (SchemaType extends AnySchema
    ? { input: SchemaType }
    : { input?: undefined });

export type EventSchemaMap = Record<string, AnySchema | undefined>;
export type EventMap<
  Resource,
  Actor,
  Context,
  Mutation,
  Schemas extends EventSchemaMap = EventSchemaMap,
> = {
  readonly [Event in keyof Schemas]: EventDefinition<
    Resource,
    Actor,
    Context,
    Mutation,
    Schemas[Event]
  >;
};

export interface LifecycleDefinition<
  Resource,
  Actor,
  Context,
  Mutation,
  Schemas extends EventSchemaMap,
> {
  name: string;
  definitionVersion?: string;
  states: readonly string[];
  events: EventMap<Resource, Actor, Context, Mutation, Schemas>;
  history: {
    resourceType: string;
    actor?: (actor: Actor) => { actorType?: string; actorId?: string };
    metadata?: (args: {
      request: {
        resourceId: string;
        event: string;
        metadata?: JsonValue;
      };
      actor: Actor;
      resource: Resource;
    }) => JsonValue;
  };
  idempotency?: {
    fingerprint(args: {
      lifecycle: string;
      resourceId: string;
      event: string;
      parsedInput: ParsedInputOf<Schemas[keyof Schemas]>;
      actor: Actor;
      expectedVersion: string;
    }): string;
  };
}

export interface Lifecycle<
  Resource,
  Actor,
  Context,
  Mutation,
  Schemas extends EventSchemaMap,
> extends LifecycleDefinition<Resource, Actor, Context, Mutation, Schemas> {
  getEvent(
    name: string,
  ):
    | EventMap<Resource, Actor, Context, Mutation, Schemas>[keyof Schemas]
    | undefined;
  parseInput(
    event: EventMap<Resource, Actor, Context, Mutation, Schemas>[keyof Schemas],
    input: unknown,
  ): Promise<ParseResult<unknown>>;
}

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
  if (!schema) {
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
  if ("parse" in schema)
    return (schema as InputSchema<unknown, unknown>).parse(input);
  const result = await (schema as StandardSchema<unknown, unknown>)[
    "~standard"
  ].validate(input);
  if (result.issues) {
    return {
      success: false,
      issues: result.issues.map((issue) => ({
        path: normalizePath(issue.path),
        code: "INVALID_INPUT",
        message: issue.message,
      })),
    };
  }
  return { success: true, value: result.value };
}

function invalid(message: string): never {
  throw new InterlockError("INTERLOCK_DEFINITION_INVALID", message);
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

export function defineLifecycle<Resource, Actor, Context, Mutation>(): <
  const Schemas extends EventSchemaMap,
>(
  definition: LifecycleDefinition<Resource, Actor, Context, Mutation, Schemas>,
) => Lifecycle<Resource, Actor, Context, Mutation, Schemas>;
export function defineLifecycle<
  Resource,
  Actor,
  Context,
  Mutation,
  const Schemas extends EventSchemaMap,
>(
  definition: LifecycleDefinition<Resource, Actor, Context, Mutation, Schemas>,
): Lifecycle<Resource, Actor, Context, Mutation, Schemas>;
export function defineLifecycle<
  Resource,
  Actor,
  Context,
  Mutation,
  const Schemas extends EventSchemaMap,
>(
  definition?: LifecycleDefinition<Resource, Actor, Context, Mutation, Schemas>,
):
  | Lifecycle<Resource, Actor, Context, Mutation, Schemas>
  | ((
      value: LifecycleDefinition<Resource, Actor, Context, Mutation, Schemas>,
    ) => Lifecycle<Resource, Actor, Context, Mutation, Schemas>) {
  if (!definition) return (value) => defineLifecycle(value);
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.name))
    invalid("Lifecycle name is invalid.");
  const states = new Set(definition.states);
  if (states.size !== definition.states.length || states.size === 0)
    invalid("Lifecycle states must be unique and non-empty.");

  const eventEntries = Object.entries(definition.events) as Array<
    [
      string,
      {
        from: readonly string[];
        to: string;
        input?: AnySchema;
        guards?: readonly { name: string }[];
      },
    ]
  >;
  const events = Object.fromEntries(
    eventEntries.map(([name, event]) => {
      if (
        !name ||
        event.from.length === 0 ||
        !states.has(event.to) ||
        event.from.some((state) => !states.has(state) || state === event.to)
      )
        invalid(`Event ${name} has invalid states.`);
      const guards = event.guards?.map((guard) => guard.name) ?? [];
      if (new Set(guards).size !== guards.length)
        invalid(`Event ${name} has duplicate guard names.`);
      if (
        event.input &&
        !("parse" in event.input) &&
        !("~standard" in event.input)
      )
        invalid(`Event ${name} has an unsupported input schema.`);
      return [
        name,
        Object.freeze({
          ...event,
          from: Object.freeze([...event.from]),
          ...(event.input ? { input: snapshotSchema(event.input) } : {}),
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
  ) as EventMap<Resource, Actor, Context, Mutation, Schemas>;

  const lifecycle: Lifecycle<Resource, Actor, Context, Mutation, Schemas> = {
    ...definition,
    states: Object.freeze([...definition.states]),
    events: Object.freeze(events),
    history: Object.freeze({ ...definition.history }),
    ...(definition.idempotency
      ? { idempotency: Object.freeze({ ...definition.idempotency }) }
      : {}),
    getEvent: (name) => events[name as keyof Schemas],
    parseInput: (event, input) => parseSchema(event.input, input),
  };
  return Object.freeze(lifecycle);
}
