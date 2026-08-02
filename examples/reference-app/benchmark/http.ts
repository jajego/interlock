import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { actors, permit, reset } from "../test/helpers.js";
import { environment, measure } from "./report.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const app = createApp(database);
try {
  await reset(database);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  let errors = 0;
  let requests = 0;
  let permitNumber = 30_000;
  const report = await measure(
    "http-submit",
    async (iteration) => {
      requests += 1;
      const row = await permit(database, {
        withDocument: true,
        permitNumber: permitNumber++,
      });
      const response = await fetch(
        `${address}/permits/${row.id}/events/submit`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tenant-id": actors.applicant.tenantId,
            "x-user-id": actors.applicant.id,
            "expected-version": String(row.version),
            "idempotency-key": `http-${iteration}-${row.id}`,
          },
          body: "{}",
        },
      );
      if (!response.ok) errors += 1;
      await response.arrayBuffer();
    },
    { warmups: 3, iterations: 20 },
  );
  process.stdout.write(
    `${JSON.stringify({ layer: "http-end-to-end", environment: environment({ prisma: "7.9.1" }), errorRate: errors / requests, reports: [report], limitation: "Local loopback only; database and HTTP setup queries are outside the timed request." }, null, 2)}\n`,
  );
} finally {
  await app.close();
  await database.$disconnect();
}
