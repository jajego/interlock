# Releasing

## First alpha

`0.1.0-alpha.1` is already versioned in every package and documented in the
changelog. Its incorporated work must not have a pending Changeset. Run the
entire local quality matrix, inspect `pnpm pack:check`, and publish through the
protected workflow with the npm `next` tag. Do not use `latest` or run
`changeset version` for this already-prepared release.

After all checks pass, the workflow configures the standard GitHub Actions bot
identity, runs `pnpm release`, and then runs `git push --follow-tags`. The push
occurs only after successful npm publication and sends generated package tags;
the workflow does not commit or push source changes.

## Later releases

Every change after the first alpha requires a Changeset. Release preparation
applies those files with `pnpm version-packages` and reviews the resulting
package versions. Changesets does not generate changelogs in this repository;
maintainers manually update the root `CHANGELOG.md` with an exact release
heading. `pnpm release:check` verifies that heading and requires no pending
Changesets before publication. Prereleases continue on `next`; publishing a
stable version on `latest` is a later, explicit maintainer decision that also
requires updating the release command.

Confirm ownership and 2FA for the npm `@jajego` scope before configuring the
protected `npm` GitHub environment. The release workflow repeats format, lint,
build, type, PostgreSQL, packaging, Prisma shared-handle, and release-state
checks before `changeset publish --tag next`.

Never publish from an unreviewed local working tree. A release must use the
protected workflow and an immutable commit whose CI checks passed.

Interlock is published on npmjs.com. GitHub's **Packages** repository sidebar
refers to GitHub Packages, a separate registry, and is not populated by
npmjs.com releases.
