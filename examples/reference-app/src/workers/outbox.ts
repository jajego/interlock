import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "../db.js";

interface OutboxRow {
  id: string;
  topic: string;
  payload: unknown;
}

export async function processOne(
  database: Database,
  workerId: string,
  deliver: (message: OutboxRow) => Promise<void> = async () => {},
): Promise<OutboxRow | undefined> {
  return database.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<Array<OutboxRow>>`
      SELECT id, topic, payload
      FROM interlock.interlock_outbox
      WHERE published_at IS NULL
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const message = rows[0];
    if (!message) return undefined;
    await deliver(message);
    await transaction.deliveredNotification.create({
      data: {
        id: randomUUID(),
        outboxId: message.id,
        topic: message.topic,
        payload: JSON.parse(JSON.stringify(message.payload)),
        workerId,
      },
    });
    await transaction.$executeRaw`
      UPDATE interlock.interlock_outbox SET published_at = now()
      WHERE id = ${message.id} AND published_at IS NULL
    `;
    return message;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const database = createDatabase(loadConfig().databaseUrl);
  try {
    const message = await processOne(database, `worker-${process.pid}`);
    process.stdout.write(`${JSON.stringify(message ?? { status: "idle" })}\n`);
  } finally {
    await database.$disconnect();
  }
}
