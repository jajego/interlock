# Migrating the pre-alpha API

- Create event definitions with `defineEvent<Resource, Actor, Context>()` when
  an event has input or a mutation. This preserves event-specific input and
  mutation inference without a user-authored discriminator.
- Remove the lifecycle-wide mutation generic. Use
  `MutationMap<typeof lifecycle.events>` in a binding annotation.
- Pass the immutable operation to `loadPrimary()` and `contextFactory.create()`.
  Read mutations from `args.operation.mutation` in write hooks.
- Remove placeholder `transactionOptions`, `contextFactory`, `applyRelated`, and
  hydration hooks. Ordinary transaction options and undefined context are
  defaults.
- Replace denial `reasons` with singular `reason`; replace `publicMessage` with
  `message` and public `details` with `publicDetails`.
- Replace `consistency()` boilerplate with `consistency: primaryRowOnly` when
  only the primary row matters.
- Configure `new PostgresDriver(pool, { schema })` instead of changing a shared
  pool's `search_path`.
