import type { createApplications } from "../examples/postgres-node/src/index.js";
import {
  type InputSchema,
  noInput,
  type TransitionRequestFor,
} from "../packages/core/src/index.js";

const unknownBoundarySchema: InputSchema<{ value: string }, string> = {
  parse(input: unknown) {
    return typeof input === "object" && input !== null && "value" in input
      ? { success: true, value: String(input.value) }
      : { success: false, issues: [] };
  },
};
void unknownBoundarySchema;

declare const applications: ReturnType<typeof createApplications>;
const actor = {
  id: "reviewer",
  permissions: ["applications:approve"] as const,
};

applications.assess({
  id: "a1",
  event: "approve",
  input: { note: "Ready" },
  actor,
});

const noInputRequest: TransitionRequestFor<
  { close: typeof noInput },
  undefined
> = {
  id: "item-1",
  event: "close",
  actor: undefined,
  expectedVersion: "1",
};
void noInputRequest;

const transitionResult = await applications.transition({
  id: "a1",
  event: "approve",
  input: { note: "Ready" },
  actor,
  expectedVersion: "1",
});
if (transitionResult.status === "committed") {
  if (transitionResult.duplicate) {
    // @ts-expect-error duplicate replays intentionally omit a current resource
    void transitionResult.resource;
  } else {
    void transitionResult.resource.state;
  }
}

applications.transition({
  id: "a1",
  // @ts-expect-error unknown lifecycle event
  event: "totally-invalid",
  input: { note: "Ready" },
  actor,
  expectedVersion: "1",
});

applications.transition({
  id: "a1",
  event: "approve",
  // @ts-expect-error note must be a string
  input: { note: 42 },
  actor,
  expectedVersion: "1",
});

applications.assess({
  id: "a1",
  event: "approve",
  input: { note: "Ready" },
  actor,
  // @ts-expect-error assess does not accept write preconditions
  expectedVersion: "1",
});

applications.transition({
  id: "a1",
  event: "approve",
  input: { note: "Ready" },
  actor,
  // @ts-expect-error expected versions are PostgreSQL BIGINT strings
  expectedVersion: 1,
});

const unexpectedNoInput: TransitionRequestFor<
  { close: typeof noInput },
  undefined
> = {
  ...noInputRequest,
  // @ts-expect-error noInput events reject submitted input
  input: {},
};
void unexpectedNoInput;
