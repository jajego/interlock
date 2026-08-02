import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, type TransactionTiming } from "../src/db.js";
import { actors, permit, reset } from "../test/helpers.js";
import { environment, measure, measureThroughput } from "./report.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
let statements = 0;
const queryCounts = new Set<number>();
const transactionTimings: TransactionTiming[] = [];
const app = createApp(database, {
  observeStatement: () => (statements += 1),
  observeTransaction: (timing) => transactionTimings.push(timing),
});
let permitNumber = 30_000;

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function request(address: string, id: string, version: bigint, key: string) {
  return async () => {
    const response = await fetch(`${address}/permits/${id}/events/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": actors.applicant.tenantId,
        "x-user-id": actors.applicant.id,
        "expected-version": String(version),
        "idempotency-key": key,
      },
      body: "{}",
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };
}

try {
  await reset(database);
  const postgres = await database.$queryRaw<
    Array<{ version: string }>
  >`SELECT current_setting('server_version') version`;
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const report = await measure(
    "http-submit",
    async (iteration) => {
      const row = await permit(database, {
        withDocument: true,
        permitNumber: permitNumber++,
      });
      statements = 0;
      return {
        run: async () => {
          await request(
            address,
            row.id,
            row.version,
            `http-${iteration}-${row.id}`,
          )();
          queryCounts.add(statements);
        },
        cleanup: async () => {
          await database.$executeRaw`
            DELETE FROM interlock.interlock_idempotency WHERE resource_id = ${row.id}
          `;
          await database.$executeRaw`
            DELETE FROM interlock.interlock_transition_history WHERE resource_id = ${row.id}
          `;
          await database.permit.delete({ where: { id: row.id } });
        },
      };
    },
    { warmups: 10, iterations: 100, rounds: 3 },
  );
  if (queryCounts.size !== 1 || [...queryCounts][0] !== 8)
    throw new Error("HTTP query count changed between samples.");
  const latencyTransactionTimings = transactionTimings.splice(0);

  const throughputRows = await Promise.all(
    Array.from({ length: 100 }, () =>
      permit(database, {
        withDocument: true,
        permitNumber: permitNumber++,
      }),
    ),
  );
  const throughput = await measureThroughput(
    "http-submit-concurrent",
    throughputRows.map((row, index) =>
      request(address, row.id, row.version, `throughput-${index}-${row.id}`),
    ),
    10,
  );
  const throughputTransactionTimings = transactionTimings.splice(0);
  for (const row of throughputRows) {
    await database.$executeRaw`
      DELETE FROM interlock.interlock_idempotency WHERE resource_id = ${row.id}
    `;
    await database.$executeRaw`
      DELETE FROM interlock.interlock_transition_history WHERE resource_id = ${row.id}
    `;
    await database.permit.delete({ where: { id: row.id } });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        layer: "http-end-to-end",
        environment: environment({
          prisma: "7.9.1",
          postgres: postgres[0]?.version,
          poolMax: 10,
        }),
        queryCount: [...queryCounts][0],
        transactionControlIncludedInQueryCount: false,
        transactionTimingMs: {
          latencySamples: {
            poolWaitMean: mean(
              latencyTransactionTimings.map((timing) => timing.poolWaitMs),
            ),
            insideTransactionMean: mean(
              latencyTransactionTimings.map((timing) => timing.transactionMs),
            ),
          },
          throughputSamples: {
            poolWaitMean: mean(
              throughputTransactionTimings.map((timing) => timing.poolWaitMs),
            ),
            insideTransactionMean: mean(
              throughputTransactionTimings.map(
                (timing) => timing.transactionMs,
              ),
            ),
          },
        },
        report,
        throughput,
        limitation:
          "Local loopback only; migration, seed, permit setup, and cleanup are outside timed regions.",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await app.close();
  await database.$disconnect();
}
