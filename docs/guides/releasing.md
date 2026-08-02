# Releasing

## First alpha

`0.1.0-alpha.0` is already versioned in every package and documented in the
changelog. Its incorporated work must not have a pending Changeset. Run the
entire local quality matrix, inspect `pnpm pack:check`, and publish through the
protected workflow with the npm `next` tag. Do not use `latest` or run
`changeset version` for this already-prepared release.

## Later releases

Every change after the first alpha requires a Changeset. Release preparation
applies those files with `pnpm version-packages`, reviews the resulting package
versions and changelog, and leaves no pending Changesets before publishing.
Prereleases continue on `next`; publishing a stable version on `latest` is a
later, explicit maintainer decision that also requires updating the release
command.

Confirm ownership and 2FA for the npm `@interlock` scope before configuring the
protected `npm` GitHub environment. The release workflow repeats format, lint,
build, type, PostgreSQL, packaging, Prisma shared-handle, and release-state
checks before `changeset publish --tag next`.

Never publish from an unreviewed local working tree. A release must use the
protected workflow and an immutable commit whose CI checks passed.
