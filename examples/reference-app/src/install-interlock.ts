import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig } from "./config.js";

const pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 1 });
const client = await pool.connect();
try {
  const migration = await readFile(
    fileURLToPath(import.meta.resolve("@interlock/postgres/migration.sql")),
    "utf8",
  );
  await client.query('CREATE SCHEMA IF NOT EXISTS "interlock"');
  await client.query('SET search_path = "interlock"');
  await client.query(migration);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE public.review_decisions
        ADD CONSTRAINT review_decisions_transition_fk
        FOREIGN KEY (transition_id)
        REFERENCES interlock.interlock_transition_history(id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
} finally {
  client.release();
  await pool.end();
}
