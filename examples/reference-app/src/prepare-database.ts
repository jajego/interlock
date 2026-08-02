import { Pool } from "pg";
import { loadConfig } from "./config.js";

const target = new URL(loadConfig().databaseUrl);
const databaseName = target.pathname.slice(1);
if (!/^[a-zA-Z0-9_]+$/.test(databaseName))
  throw new Error(
    "Reference database name must contain only letters, numbers, and underscores.",
  );
target.pathname = "/postgres";
const pool = new Pool({ connectionString: target.toString(), max: 1 });
try {
  const existing = await pool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [databaseName],
  );
  if (existing.rowCount === 0)
    await pool.query(`CREATE DATABASE "${databaseName}"`);
} finally {
  await pool.end();
}
