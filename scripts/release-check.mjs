import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageNames = ["core", "postgres", "conformance"];
const versions = packageNames.map(
  (name) =>
    JSON.parse(readFileSync(join(root, "packages", name, "package.json")))
      .version,
);
const pending = readdirSync(join(root, ".changeset")).filter((name) =>
  name.endsWith(".md"),
);

assert.equal(new Set(versions).size, 1, "Release package versions must match.");
assert.equal(pending.length, 0, `Pending Changesets: ${pending.join(", ")}`);
assert.match(
  readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  new RegExp(versions[0].replaceAll(".", "\\.")),
  `CHANGELOG.md must mention ${versions[0]}.`,
);
process.stdout.write(
  `Release state ready for ${versions[0]} with npm tag next.\n`,
);
