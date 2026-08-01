import {
  canonicalHash,
  createInterlock,
  defineLifecycle,
  deny,
  allow,
  type InputSchema,
  type ResourceBinding,
  type VersionToken,
} from "@interlock/core";
import { PostgresDriver, type PgTransaction } from "@interlock/postgres";
import { Pool } from "pg";

interface Application {
  id: string;
  ownerId: string;
  state: string;
  version: VersionToken;
  decisionNote: string | null;
}
interface Actor {
  id: string;
  permissions: readonly string[];
}
interface Context {
  documents: { allVerified(id: string): Promise<boolean> };
}
interface Mutation {
  decisionNote: string | null;
}

const noteSchema: InputSchema<unknown, { note?: string }> = {
  parse(input) {
    if (typeof input !== "object" || input === null)
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
    const note = Reflect.get(input, "note");
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

export const applicationLifecycle = defineLifecycle<
  Application,
  Actor,
  Context,
  Mutation
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
        input: parsedInput as never,
        actorId: actor.id,
        expectedVersion,
      }),
  },
  events: {
    approve: {
      from: ["under_review"],
      to: "approved",
      input: noteSchema,
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
      mutate: ({ input }) => ({
        decisionNote: (input as { note?: string }).note ?? null,
      }),
      audit: ({ input }) => ({
        noteProvided: (input as { note?: string }).note !== undefined,
      }),
      outbox: ({ resource, transitionId }) => [
        {
          topic: "application.approved",
          key: resource.id,
          payload: { applicationId: resource.id, transitionId },
        },
      ],
    },
    reject: {
      from: ["under_review"],
      to: "rejected",
      input: noteSchema,
      authorize: ({ actor }) =>
        actor.permissions.includes("applications:reject")
          ? allow()
          : deny({ code: "MISSING_PERMISSION" }),
      mutate: ({ input }) => ({
        decisionNote: (input as { note?: string }).note ?? null,
      }),
    },
  },
});

const mapApplication = (row: Record<string, unknown>): Application => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  state: String(row.state),
  version: String(row.version) as VersionToken,
  decisionNote: row.decision_note == null ? null : String(row.decision_note),
});

export const applicationBinding: ResourceBinding<
  PgTransaction,
  Application,
  Mutation,
  Context
> = {
  transactionOptions: ({ mode }) =>
    mode === "advisory"
      ? { isolation: "read-committed", readOnly: true }
      : { isolation: "read-committed" },
  loadPrimary: async (tx, id) => {
    const result = await tx.query("SELECT * FROM applications WHERE id = $1", [
      id,
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
        args.mutation.decisionNote,
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
        args.mutation.decisionNote,
        args.occurredAt,
      ],
    );
  },
  contextFactory: {
    create: (tx, { mode }) => ({
      documents: {
        allVerified: async (id) => {
          if (mode === "authoritative")
            await tx.query(
              "SELECT id FROM application_documents WHERE application_id = $1 FOR UPDATE",
              [id],
            );
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
          strategy: "row-locking",
          notes: "Document rows are locked for authoritative approval.",
        }
      : {
          strategy: "none",
          notes: "Rejection depends only on the primary row.",
        },
};

export function createApplications(pool: Pool) {
  return createInterlock({
    lifecycle: applicationLifecycle,
    driver: new PostgresDriver(pool),
    binding: applicationBinding,
  });
}

async function main() {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const applications = createApplications(pool);
    console.log(
      await applications.transition({
        id: "example",
        event: "approve",
        input: { note: "Ready" },
        actor: { id: "reviewer", permissions: ["applications:approve"] },
        expectedVersion: "1",
        idempotency: { key: "example-approve" },
      }),
    );
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
)
  await main();
