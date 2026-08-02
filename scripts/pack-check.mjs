import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
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

try {
  rmSync(packs, { recursive: true, force: true });
  mkdirSync(packs, { recursive: true });
  for (const name of ["core", "postgres", "conformance"])
    pnpm(["pack", "--pack-destination", packs], {
      cwd: join(root, "packages", name),
      stdio: "inherit",
    });

  const tarballs = readdirSync(packs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(packs, name));
  assert.equal(tarballs.length, 3);
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        ["core", "postgres", "conformance"].map((name) => [
          `@interlock/${name}`,
          `file:${tarballs.find((file) => file.includes(`interlock-${name}-`))}`,
        ]),
      ),
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
    'await Promise.all([import("@interlock/core"), import("@interlock/postgres"), import("@interlock/conformance")]);\n',
  );
  execFileSync(process.execPath, ["verify.mjs"], {
    cwd: temporary,
    stdio: "inherit",
  });
  for (const name of ["core", "postgres", "conformance"]) {
    const directory = join(temporary, "node_modules", "@interlock", name);
    assert.match(
      readFileSync(join(directory, "README.md"), "utf8"),
      /Interlock|@interlock/,
    );
    assert.match(
      readFileSync(join(directory, "LICENSE"), "utf8"),
      /Apache License/,
    );
    const files = readdirSync(join(directory, "dist"));
    assert.equal(
      files.some((file) => file.includes("test")),
      false,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
