import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRelease } from "./release-check.mjs";

const root = join(import.meta.dirname, "..");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "interlock-release-check-"));
  for (const name of [
    "package.json",
    "CHANGELOG.md",
    ".changeset",
    ".github",
    "docs",
  ])
    cpSync(join(root, name), join(directory, name), { recursive: true });
  for (const packageName of ["core", "postgres", "conformance"]) {
    const target = join(directory, "packages", packageName);
    mkdirSync(target, { recursive: true });
    for (const file of ["package.json", "README.md"])
      cpSync(join(root, "packages", packageName, file), join(target, file));
  }
  for (const example of ["postgres-node", "reference-app"]) {
    const target = join(directory, "examples", example);
    mkdirSync(target, { recursive: true });
    cpSync(
      join(root, "examples", example, "README.md"),
      join(target, "README.md"),
    );
  }
  return directory;
}

function withFixture(run) {
  const directory = fixture();
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("release check accepts the prepared first alpha", () => {
  const release = checkRelease(root);
  assert.deepEqual(release, { version: "0.1.0-alpha.0", tag: "next" });
});

test("version text in prose does not satisfy the changelog heading", () =>
  withFixture((directory) => {
    writeFileSync(
      join(directory, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n\nMentions 0.1.0-alpha.0 in prose.\n",
    );
    assert.throws(() => checkRelease(directory), /exact .* release heading/);
  }));

test("an Unreleased heading cannot stand in for the release heading", () =>
  withFixture((directory) => {
    const changelog = readFileSync(
      join(directory, "CHANGELOG.md"),
      "utf8",
    ).replace("## 0.1.0-alpha.0 — 2026-08-02", "## Unreleased");
    writeFileSync(join(directory, "CHANGELOG.md"), changelog);
    assert.throws(() => checkRelease(directory), /exact .* release heading/);
  }));

test("pending Changesets are rejected", () =>
  withFixture((directory) => {
    writeFileSync(join(directory, ".changeset", "pending.md"), "---\n---\n");
    assert.throws(() => checkRelease(directory), /Pending Changesets/);
  }));

test("mismatched public package versions are rejected", () =>
  withFixture((directory) => {
    const file = join(directory, "packages", "core", "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.version = "0.1.0-alpha.1";
    writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => checkRelease(directory), /versions must match/);
  }));

test("unexpected public package names are rejected", () =>
  withFixture((directory) => {
    const file = join(directory, "packages", "core", "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.name = "@example/interlock";
    writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => checkRelease(directory), /@jajego publish list/);
  }));

test("stale package scopes and removed DX links are rejected", () =>
  withFixture((directory) => {
    writeFileSync(
      join(directory, "README.md"),
      "Install `@interlock/core` and see dx-findings.md.\n",
    );
    assert.throws(() => checkRelease(directory), /authoritative @jajego/);
  }));
