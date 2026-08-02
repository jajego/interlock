import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("DROP SCHEMA IF EXISTS interlock_example CASCADE");
  await client.query("CREATE SCHEMA interlock_example");
  await client.query("SET search_path = interlock_example");
  const migration = await readFile(
    fileURLToPath(import.meta.resolve("@interlock/postgres/migration.sql")),
    "utf8",
  );
  const schema = await readFile(
    new URL("../schema.sql", import.meta.url),
    "utf8",
  );
  await client.query(migration);
  await client.query(schema);
  await client.query(
    "INSERT INTO applications (id, owner_id, state) VALUES ('example', 'owner', 'under_review')",
  );
  await client.query(
    "INSERT INTO application_documents (id, application_id, verified) VALUES ('document', 'example', true)",
  );
  console.log("interlock_example is ready");
} finally {
  client.release();
  await pool.end();
}
