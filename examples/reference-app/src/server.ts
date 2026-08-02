import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const app = createApp(database, { logger: true, bodyLimit: config.bodyLimit });
let closing = false;
async function close(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.$disconnect();
}
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await close("startup-failure");
  process.exitCode = 1;
}
