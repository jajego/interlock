# `@interlock/postgres`

Reference `pg` transaction driver plus the versioned Interlock idempotency,
history, and outbox schema. Apply the exported `migration.sql` before use.

```sh
pnpm add @interlock/core @interlock/postgres pg
```

Applications create the `pg` `Pool` and pass it to `new PostgresDriver(pool)`;
`pg` is a peer dependency so Interlock shares the application's pool package.

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PostgresDriver } from "@interlock/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const driver = new PostgresDriver(pool, { schema: "interlock" });

const sql = await readFile(
  fileURLToPath(import.meta.resolve("@interlock/postgres/migration.sql")),
  "utf8",
);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query('SET LOCAL search_path = "interlock"');
  await client.query(
    sql.replace(/^BEGIN;\s*/m, "").replace(/COMMIT;\s*$/m, ""),
  );
  await client.query("COMMIT");
} finally {
  client.release();
}
```

The migration targets the transaction-local active schema and is intended for a
clean installation. Runtime SQL safely qualifies the configured schema; it does
not depend on a shared pool's `search_path`. Idempotent transitions use
`read-committed`; the executor rejects higher isolation levels rather than
claiming an unproved algorithm.

This package guarantees atomic insertion, not outbox delivery. The
transition-history table is append-only by protocol; applications that need
database enforcement should deny their runtime role `UPDATE` and `DELETE` on
that table. Outbox rows are inserted in parameterized batches of up to 500 to
limit database round trips without approaching PostgreSQL's parameter limit.
Node.js 22.14 or newer and `pg` 8.16.3 through 8.x are supported.
