import type { createApplications } from "../examples/postgres-node/src/index.js";
import {
  noInput,
  type TransitionRequestFor,
} from "../packages/core/src/index.js";

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

applications.transition({
  id: "a1",
  event: "approve",
  input: { note: "Ready" },
  actor,
  expectedVersion: "1",
});

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
