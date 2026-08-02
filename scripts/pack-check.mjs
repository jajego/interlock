import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packs = join(root, ".packs");
const temporary = mkdtempSync(join(tmpdir(), "interlock-pack-"));
const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, "Run this check through pnpm pack:check");
const pnpm = (arguments_, options) =>
  execFileSync(process.execPath, [pnpmCli, ...arguments_], options);

const packages = {
  core: [
    "errors",
    "executor",
    "index",
    "json",
    "lifecycle",
    "types",
    "version",
  ],
  postgres: ["driver", "index"],
  conformance: ["binding", "driver", "executor", "faults", "index"],
};

function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesBelow(join(directory, entry.name), relative)
      : [relative];
  });
}

function expectedFiles(name) {
  const files = new Set(["LICENSE", "README.md", "package.json"]);
  for (const module of packages[name])
    for (const suffix of ["d.ts", "js"]) files.add(`dist/${module}.${suffix}`);
  if (name === "postgres") files.add("migrations/001_interlock.sql");
  return [...files].sort();
}

try {
  rmSync(packs, { recursive: true, force: true });
  for (const name of [...Object.keys(packages), "../examples/postgres-node"]) {
    const directory = name.startsWith("../")
      ? join(root, name.slice(3))
      : join(root, "packages", name);
    rmSync(join(directory, "dist"), { recursive: true, force: true });
    rmSync(join(directory, "tsconfig.tsbuildinfo"), { force: true });
    for (const file of readdirSync(directory))
      if (file.endsWith(".tgz")) rmSync(join(directory, file));
  }
  pnpm(["build"], { cwd: root, stdio: "inherit" });
  mkdirSync(packs, { recursive: true });
  for (const name of Object.keys(packages))
    pnpm(["pack", "--pack-destination", packs], {
      cwd: join(root, "packages", name),
      stdio: "inherit",
    });

  const tarballs = readdirSync(packs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(packs, name));
  assert.equal(tarballs.length, 3);
  for (const tarball of tarballs)
    process.stdout.write(
      `${tarball.slice(packs.length + 1)}: ${statSync(tarball).size} bytes\n`,
    );
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...Object.fromEntries(
          Object.keys(packages).map((name) => [
            `@interlock/${name}`,
            `file:${tarballs.find((file) => file.includes(`interlock-${name}-`))}`,
          ]),
        ),
        pg: "^8.16.3",
      },
      devDependencies: {
        "@types/node": "20.5.9",
        "@types/pg": "8.10.2",
        typescript: "5.0.4",
      },
    }),
  );
  writeFileSync(
    join(temporary, "pnpm-workspace.yaml"),
    `packages: []\noverrides:\n  '@interlock/core': 'file:${tarballs.find((file) => file.includes("interlock-core-"))}'\n`,
  );
  pnpm(["install", "--ignore-scripts", "--config.node-linker=hoisted"], {
    cwd: temporary,
    stdio: "inherit",
  });
  writeFileSync(
    join(temporary, "verify.mjs"),
    `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
await Promise.all([import("@interlock/core"), import("@interlock/postgres"), import("@interlock/conformance")]);
const migration = await readFile(fileURLToPath(import.meta.resolve("@interlock/postgres/migration.sql")), "utf8");
assert.match(migration, /CREATE TABLE IF NOT EXISTS interlock_transition_history/);
`,
  );
  writeFileSync(
    join(temporary, "verify.ts"),
    'import { PostgresDriver } from "@interlock/postgres";\nimport { Pool } from "pg";\nnew PostgresDriver(new Pool());\n',
  );
  copyFileSync(
    join(root, "examples", "postgres-node", "src", "index.ts"),
    join(temporary, "example.ts"),
  );
  writeFileSync(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["verify.ts", "example.ts"],
    }),
  );
  execFileSync(process.execPath, ["verify.mjs"], {
    cwd: temporary,
    stdio: "inherit",
  });
  pnpm(["exec", "tsc"], { cwd: temporary, stdio: "inherit" });
  for (const name of Object.keys(packages)) {
    const directory = join(temporary, "node_modules", "@interlock", name);
    assert.match(
      readFileSync(join(directory, "README.md"), "utf8"),
      /Interlock|@interlock/,
    );
    assert.match(
      readFileSync(join(directory, "LICENSE"), "utf8"),
      /Apache License/,
    );
    assert.deepEqual(filesBelow(directory).sort(), expectedFiles(name));
  }
  const postgresManifest = JSON.parse(
    readFileSync(
      join(temporary, "node_modules", "@interlock", "postgres", "package.json"),
      "utf8",
    ),
  );
  assert.equal(postgresManifest.dependencies?.pg, undefined);
  assert.equal(postgresManifest.peerDependencies?.pg, ">=8.16.3 <9");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
