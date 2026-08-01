import { InterlockError } from "./errors.js";
import type {
  Decision,
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

export interface EventDefinition<
  Resource,
  Actor,
  Context,
  Mutation,
  Submitted = undefined,
  Parsed = undefined,
> {
  from: readonly string[];
  to: string;
  input?: Schema<Submitted, Parsed>;
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
}

export type EventMap<Resource, Actor, Context, Mutation> = Record<
  string,
  EventDefinition<Resource, Actor, Context, Mutation, unknown, unknown>
>;

export interface LifecycleDefinition<
  Resource,
  Actor,
  Context,
  Mutation,
  Events extends EventMap<Resource, Actor, Context, Mutation>,
> {
  name: string;
  definitionVersion?: string;
  states: readonly string[];
  events: Events;
  history: {
    resourceType: string;
    actor?: (actor: Actor) => { actorType?: string; actorId?: string };
    metadata?: (args: {
      request: { resourceId: string; event: string; metadata?: JsonValue };
      actor: Actor;
      resource: Resource;
    }) => JsonValue;
  };
  idempotency?: {
    fingerprint(args: {
      lifecycle: string;
      resourceId: string;
      event: string;
      parsedInput: unknown;
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
  Events extends EventMap<Resource, Actor, Context, Mutation>,
> extends LifecycleDefinition<Resource, Actor, Context, Mutation, Events> {
  getEvent(name: string): Events[keyof Events] | undefined;
  parseInput(
    event: Events[keyof Events],
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
  schema: Schema<unknown, unknown> | undefined,
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
  if ("parse" in schema) return schema.parse(input);
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

export function defineLifecycle<Resource, Actor, Context, Mutation>(): <
  const Events extends EventMap<Resource, Actor, Context, Mutation>,
>(
  definition: LifecycleDefinition<Resource, Actor, Context, Mutation, Events>,
) => Lifecycle<Resource, Actor, Context, Mutation, Events>;
export function defineLifecycle<
  Resource,
  Actor,
  Context,
  Mutation,
  const Events extends EventMap<Resource, Actor, Context, Mutation>,
>(
  definition: LifecycleDefinition<Resource, Actor, Context, Mutation, Events>,
): Lifecycle<Resource, Actor, Context, Mutation, Events>;
export function defineLifecycle<
  Resource,
  Actor,
  Context,
  Mutation,
  const Events extends EventMap<Resource, Actor, Context, Mutation>,
>(
  definition?: LifecycleDefinition<Resource, Actor, Context, Mutation, Events>,
):
  | Lifecycle<Resource, Actor, Context, Mutation, Events>
  | ((
      value: LifecycleDefinition<Resource, Actor, Context, Mutation, Events>,
    ) => Lifecycle<Resource, Actor, Context, Mutation, Events>) {
  if (!definition) return (value) => defineLifecycle(value);
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.name))
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Lifecycle name is invalid.",
    );
  const states = new Set(definition.states);
  if (states.size !== definition.states.length || states.size === 0)
    throw new InterlockError(
      "INTERLOCK_DEFINITION_INVALID",
      "Lifecycle states must be unique and non-empty.",
    );
  for (const [name, event] of Object.entries(definition.events)) {
    if (
      !name ||
      event.from.length === 0 ||
      !states.has(event.to) ||
      event.from.some((state) => !states.has(state) || state === event.to)
    ) {
      throw new InterlockError(
        "INTERLOCK_DEFINITION_INVALID",
        `Event ${name} has invalid states.`,
      );
    }
    const guards = event.guards?.map((guard) => guard.name) ?? [];
    if (new Set(guards).size !== guards.length)
      throw new InterlockError(
        "INTERLOCK_DEFINITION_INVALID",
        `Event ${name} has duplicate guard names.`,
      );
    if (
      event.input &&
      !("parse" in event.input) &&
      !("~standard" in event.input)
    )
      throw new InterlockError(
        "INTERLOCK_DEFINITION_INVALID",
        `Event ${name} has an unsupported input schema.`,
      );
  }
  const lifecycle: Lifecycle<Resource, Actor, Context, Mutation, Events> = {
    ...definition,
    states: Object.freeze([...definition.states]),
    events: Object.freeze({ ...definition.events }),
    getEvent: (name: string) =>
      definition.events[name] as Events[keyof Events] | undefined,
    parseInput: (event, input) => parseSchema(event.input, input),
  };
  return Object.freeze(lifecycle);
}
