import {
  canonicalHash,
  createInterlock,
  defineEvent,
  defineLifecycle,
  deny,
  allow,
  type BindingFor,
  type InputSchema,
  type TransactionDriver,
} from "@interlock/core";
import { PostgresDriver, type PgTransaction } from "@interlock/postgres";
import { Pool } from "pg";
import { pathToFileURL } from "node:url";

interface Application {
  id: string;
  ownerId: string;
  state: string;
  version: string;
  decisionNote: string | null;
}
interface Actor {
  id: string;
  permissions: readonly string[];
}
interface Context {
  documents: { allVerified(id: string): Promise<boolean> };
}
const noteSchema: InputSchema<{ note?: string }, { note?: string }> = {
  parse(input) {
    const submitted: unknown = input;
    if (typeof submitted !== "object" || submitted === null)
      return {
        success: false,
        issues: [
          {
            path: ["input"],
            code: "INVALID_INPUT",
            message: "Expected an object.",
          },
        ],
      };
    const note = (submitted as Record<string, unknown>).note;
    if (note !== undefined && (typeof note !== "string" || note.length > 2_000))
      return {
        success: false,
        issues: [
          {
            path: ["input", "note"],
            code: "INVALID_INPUT",
            message: "Note must be at most 2000 characters.",
          },
        ],
      };
    return { success: true, value: note === undefined ? {} : { note } };
  },
};
const event = defineEvent<Application, Actor, Context>();

export const applicationLifecycle = defineLifecycle<
  Application,
  Actor,
  Context
>()({
  name: "application",
  definitionVersion: "1",
  states: ["under_review", "approved", "rejected"],
  history: {
    resourceType: "application",
    actor: (actor) => ({ actorType: "user", actorId: actor.id }),
  },
  idempotency: {
    fingerprint: ({ resourceId, event, parsedInput, actor, expectedVersion }) =>
      canonicalHash({
        resourceId,
        event,
        input: parsedInput,
        actorId: actor.id,
        expectedVersion,
      }),
  },
  events: {
    approve: event(noteSchema, {
      from: ["under_review"],
      to: "approved",
      authorize: ({ actor }) =>
        actor.permissions.includes("applications:approve")
          ? allow()
          : deny({ code: "MISSING_PERMISSION" }),
      guards: [
        {
          name: "documents-verified",
          evaluate: async ({ resource, context }) =>
            (await context.documents.allVerified(resource.id))
              ? allow()
              : deny({ code: "DOCUMENTS_NOT_VERIFIED" }),
        },
      ],
      mutate: ({ input }) => ({ decisionNote: input.note ?? null }),
      audit: ({ input }) => ({ noteProvided: input.note !== undefined }),
      outbox: ({ resource, transitionId }) => [
        {
          topic: "application.approved",
          key: resource.id,
          payload: { applicationId: resource.id, transitionId },
        },
      ],
    }),
    reject: event(noteSchema, {
      from: ["under_review"],
      to: "rejected",
      authorize: ({ actor }) =>
        actor.permissions.includes("applications:reject")
          ? allow()
          : deny({ code: "MISSING_PERMISSION" }),
      mutate: ({ input }) => ({ decisionNote: input.note ?? null }),
    }),
  },
});

const mapApplication = (row: Record<string, unknown>): Application => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  state: String(row.state),
  version: String(row.version),
  decisionNote: row.decision_note == null ? null : String(row.decision_note),
});

export const applicationBinding: BindingFor<
  PgTransaction,
  typeof applicationLifecycle
> = {
  transactionOptions: ({ mode }) =>
    mode === "advisory"
      ? { isolation: "read-committed", readOnly: true }
      : { isolation: "read-committed" },
  loadPrimary: async (tx, operation) => {
    const result = await tx.query("SELECT * FROM applications WHERE id = $1", [
      operation.id,
    ]);
    return result.rows[0] ? mapApplication(result.rows[0]) : null;
  },
  getId: (resource) => resource.id,
  getState: (resource) => resource.state,
  getVersion: (resource) => resource.version,
  applyPrimary: async (tx, args) => {
    const result = await tx.query(
      `UPDATE applications SET state = $2, version = $3, decision_note = $4
       WHERE id = $1 AND state = $5 AND version = $6 RETURNING *`,
      [
        args.resource.id,
        args.toState,
        args.nextVersion,
        args.operation.mutation.decisionNote,
        args.fromState,
        args.expectedVersion,
      ],
    );
    return result.rows[0]
      ? { status: "applied", resource: mapApplication(result.rows[0]) }
      : { status: "conflict" };
  },
  applyRelated: async (tx, args) => {
    await tx.query(
      "INSERT INTO application_decisions (application_id, transition_id, note, occurred_at) VALUES ($1,$2,$3,$4)",
      [
        args.updatedResource.id,
        args.transitionId,
        args.operation.mutation.decisionNote,
        args.occurredAt,
      ],
    );
  },
  contextFactory: {
    create: (tx) => ({
      documents: {
        allVerified: async (id) => {
          const result = await tx.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM application_documents WHERE application_id = $1 AND NOT verified",
            [id],
          );
          return result.rows[0]?.count === "0";
        },
      },
    }),
  },
  consistency: (event) =>
    event === "approve"
      ? {
          strategy: "aggregate-version",
          notes:
            "Database triggers increment the application version for every document insert, update, or delete; approval checks that version.",
        }
      : {
          strategy: "none",
          notes: "Rejection depends only on the primary row.",
        },
};

export function createApplications(
  pool: Pool,
  driver: TransactionDriver<PgTransaction> = new PostgresDriver(pool),
) {
  return createInterlock({
    lifecycle: applicationLifecycle,
    driver,
    binding: applicationBinding,
  });
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  try {
    const applications = createInterlock({
      lifecycle: applicationLifecycle,
      driver: new PostgresDriver(pool, { schema: "interlock_example" }),
      binding: {
        ...applicationBinding,
        loadPrimary: async (transaction, operation) => {
          await transaction.query(
            'SET LOCAL search_path = "interlock_example"',
          );
          return applicationBinding.loadPrimary(transaction, operation);
        },
      },
    });
    const request = {
      id: "example",
      event: "approve" as const,
      input: { note: "Ready" },
      actor: { id: "reviewer", permissions: ["applications:approve"] },
      expectedVersion: "2",
      idempotency: { key: "example-approve" },
    };
    console.log("assessment", await applications.assess(request));
    console.log("transition", await applications.transition(request));
    console.log("duplicate", await applications.transition(request));
    console.log(
      "stale",
      await applications.transition({
        ...request,
        idempotency: { key: "example-stale" },
      }),
    );
    const rows = await pool.query(`SELECT
      (SELECT count(*)::int FROM "interlock_example"."interlock_transition_history") AS history,
      (SELECT count(*)::int FROM "interlock_example"."interlock_outbox") AS outbox`);
    console.log("stored", rows.rows[0]);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
