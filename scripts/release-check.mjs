import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packages = {
  core: "@jajego/interlock",
  postgres: "@jajego/interlock-postgres",
  conformance: "@jajego/interlock-conformance",
};
const releaseDate = "2026-08-03";
const repository = "git+https://github.com/jajego/interlock.git";
const approvedActions = new Set([
  "actions/checkout@v6",
  "actions/setup-node@v6",
  "pnpm/action-setup@v6",
]);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(path)
      : entry.name.endsWith(".md")
        ? [path]
        : [];
  });
}

export function checkRelease(root) {
  const manifests = Object.keys(packages).map((name) =>
    JSON.parse(readFileSync(join(root, "packages", name, "package.json"))),
  );
  assert.deepEqual(
    manifests.map((manifest) => manifest.name),
    Object.values(packages),
    "Release package names must match the @jajego publish list.",
  );
  const versions = manifests.map((manifest) => manifest.version);
  const version = versions[0];
  assert.equal(
    new Set(versions).size,
    1,
    "Release package versions must match.",
  );
  assert.ok(version, "Release package version is required.");

  const pending = readdirSync(join(root, ".changeset")).filter((name) =>
    name.endsWith(".md"),
  );
  assert.equal(pending.length, 0, `Pending Changesets: ${pending.join(", ")}`);

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(
    changelog,
    new RegExp(`^## ${version.replaceAll(".", "\\.")} — ${releaseDate}$`, "m"),
    `CHANGELOG.md must contain the exact ${version} release heading.`,
  );

  const documentation = [
    join(root, "README.md"),
    ...markdownFiles(join(root, "docs")),
    ...Object.keys(packages).map((name) =>
      join(root, "packages", name, "README.md"),
    ),
    join(root, "examples", "postgres-node", "README.md"),
    join(root, "examples", "reference-app", "README.md"),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    documentation,
    /@interlock(?:\/|`|\s)/,
    "Documentation must use the authoritative @jajego package scope.",
  );
  assert.doesNotMatch(
    documentation,
    /dx-findings\.md/i,
    "Documentation must not link removed development artifacts.",
  );

  for (const manifest of manifests) {
    assert.equal(
      manifest.repository?.url,
      repository,
      `${manifest.name} repository URL must match.`,
    );
    assert.equal(manifest.publishConfig?.access, "public");
    assert.equal(manifest.publishConfig?.provenance, true);
  }

  const rootManifest = JSON.parse(readFileSync(join(root, "package.json")));
  assert.match(
    rootManifest.scripts?.release ?? "",
    /changeset publish --tag next/,
    "The first alpha must publish under the next dist-tag.",
  );

  for (const workflow of ["ci.yml", "release.yml"]) {
    const contents = readFileSync(
      join(root, ".github", "workflows", workflow),
      "utf8",
    );
    for (const match of contents.matchAll(/uses:\s*([^\s]+)/g))
      assert.ok(
        approvedActions.has(match[1]),
        `${workflow} uses unapproved action ${match[1]}.`,
      );
  }

  const releaseWorkflow = readFileSync(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const publish = releaseWorkflow.indexOf("pnpm release");
  const push = releaseWorkflow.indexOf("git push --follow-tags");
  assert.ok(
    publish >= 0 && push > publish,
    "Release tags must be pushed after publish.",
  );
  return { version, tag: "next" };
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const release = checkRelease(root);
  process.stdout.write(
    `Release state ready for ${release.version} with npm tag ${release.tag}.\n`,
  );
}
