# Releasing

Confirm ownership and 2FA for the npm `@interlock` scope before configuring the
protected `npm` GitHub environment. Add a Changeset, run the entire local
quality matrix, and inspect `pnpm pack:check` output. The release workflow
repeats format, lint, build, type, PostgreSQL, packaging, and Prisma
shared-handle checks before `changeset publish --provenance`.

Never publish from an unreviewed local working tree. A release must use the
protected workflow and an immutable commit whose CI checks passed.
