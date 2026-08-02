# Alpha launch checklist

## Repository

- [ ] Create or rename the public repository to `jajego/interlock`.
- [ ] Enable private vulnerability reporting before advertising that route.
- [ ] Confirm Actions, issue templates, license, governance, and support pages.
- [ ] Confirm CI passes on Node.js 24 and 26 with PostgreSQL 16.

## npm

- [ ] Confirm control of the `@interlock` npm scope.
- [ ] Review `pnpm pack:check` file lists and tarball sizes.
- [ ] Confirm trusted publishing/provenance for the release environment.
- [ ] Publish only through the reviewed release workflow.

## Announcement

- [ ] Lead with the single-transaction PostgreSQL guarantee and alpha status.
- [ ] Link the runnable example and document the read-committed idempotency
      limit.
- [ ] State that outbox delivery, workflow execution, and crash retries are out
      of scope.
- [ ] Invite focused binding, transaction, packaging, and documentation
      feedback.
