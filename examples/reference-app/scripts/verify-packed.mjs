import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(app));
const temporary = mkdtempSync(join(tmpdir(), "interlock-reference-consumer-"));
const consumer = join(temporary, "app");
const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, "Run through pnpm verify:packed");

const pnpmCliIsJavaScript = /\.[cm]?js$/i.test(pnpmCli);

const executePnpm = (arguments_, options = {}) =>
  pnpmCliIsJavaScript
    ? execFileSync(process.execPath, [pnpmCli, ...arguments_], options)
    : execFileSync(pnpmCli, arguments_, options);

const run = (arguments_, options = {}) =>
  executePnpm(arguments_, {
    cwd: consumer,
    stdio: "inherit",
    ...options,
  });
const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
assert.ok(sourceUrl, "TEST_DATABASE_URL or DATABASE_URL is required");
const databaseName = `interlock_reference_${Date.now()}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const databaseUrl = new URL(sourceUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });

try {
  executePnpm(["pack:check"], {
    cwd: root,
    stdio: "inherit",
  });
  cpSync(app, consumer, {
    recursive: true,
    filter: (source) =>
      !["node_modules", "dist", "benchmark-results"].includes(basename(source)),
  });
  const manifest = JSON.parse(
    readFileSync(join(consumer, "package.json"), "utf8"),
  );
  const packages = {
    core: "@jajego/interlock",
    postgres: "@jajego/interlock-postgres",
  };
  const tarballPrefix = (packageName) =>
    `${packageName.slice(1).replace("/", "-")}-`;
  for (const packageName of Object.values(packages)) {
    const tarball = readdirSync(join(root, ".packs")).find((file) =>
      file.startsWith(tarballPrefix(packageName)),
    );
    assert.ok(tarball);
    manifest.dependencies[packageName] =
      `file:${join(root, ".packs", tarball)}`;
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    [
      "packages: []",
      "overrides:",
      `  "@jajego/interlock": "${manifest.dependencies["@jajego/interlock"].replaceAll("\\", "/")}"`,
      "allowBuilds:",
      '  "@prisma/client": true',
      '  "@prisma/engines": true',
      "  esbuild: true",
      "  prisma: true",
      "",
    ].join("\n"),
  );
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const environment = { ...process.env, DATABASE_URL: databaseUrl.toString() };
  run(["install", "--frozen-lockfile=false"], {
    env: environment,
  });
  for (const command of ["generate", "migrate", "seed", "build", "test"])
    run([command], { env: environment });
  const port = 31_987;
  const server = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: consumer,
    env: { ...environment, PORT: String(port) },
    stdio: "ignore",
  });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const created = await globalThis.fetch(
          `http://127.0.0.1:${port}/permits`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tenant-id": "tenant-a",
              "x-user-id": "applicant-a",
            },
            body: JSON.stringify({
              permitNumber: 999,
              applicantName: "Packed Consumer",
            }),
          },
        );
        if (created.status === 201) {
          const permit = await created.json();
          const transitioned = await globalThis.fetch(
            `http://127.0.0.1:${port}/permits/${permit.id}/events/cancel`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-tenant-id": "tenant-a",
                "x-user-id": "applicant-a",
                "expected-version": "1",
                "idempotency-key": "packed-cancel",
              },
              body: "{}",
            },
          );
          assert.equal(transitioned.status, 200);
          process.stdout.write("Packed consumer transition passed.\n");
          break;
        }
      } catch (error) {
        if (attempt === 49) throw error;
      }
      await sleep(100);
      if (attempt === 49) throw new Error("Packed server did not become ready");
    }
  } finally {
    server.kill("SIGTERM");
  }
} finally {
  await admin
    .query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    )
    .catch(() => {});
  await admin
    .query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    .catch(() => {});
  await admin.end();
  rmSync(temporary, { recursive: true, force: true });
}
