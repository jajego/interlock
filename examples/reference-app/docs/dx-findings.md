# DX findings

Measured before any Interlock change. No core change was made.

| Finding                                                                                                                                                | Classification                  | Disposition                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Prisma requires a custom `TransactionDriver` for interactive transactions and raw Interlock-table SQL.                                                 | ORM-specific burden             | Keep in the app; evaluate an optional adapter only after more integrations. |
| Prisma JSON/raw-row types require normalization at the driver boundary.                                                                                | ORM-specific burden             | Driver owns it.                                                             |
| `BindingFor<Transaction, typeof lifecycle>` and `ClientFor<typeof lifecycle>` are the only explicit Interlock generics outside lifecycle construction. | Necessary Interlock integration | Acceptable and useful.                                                      |
| Exact optional property types require omitting absent input keys rather than passing `undefined`.                                                      | Application policy              | Keep explicit route normalization.                                          |
| `applyPrimary()` intentionally has no transition timestamp; `updatedAt` remains an application concern.                                                | Necessary Interlock integration | Prisma maintains `updated_at`.                                              |
| Tenant membership must be loaded before calling Interlock, then tenant identity is repeated in operation context and transaction-local settings.       | Application policy              | Required because Interlock does not own authentication or tenancy.          |
| Prisma driver outbox insertion is one statement per message rather than the reference `pg` driver's batch.                                             | Potential Interlock DX defect   | Document; do not change the driver contract without broader measurements.   |
| Applying the official self-transactional SQL migration to a dedicated schema needs a small `pg` migration connection beside Prisma tooling.            | ORM-specific burden             | Migration-only; runtime still uses one Prisma transaction.                  |
| Operational failures throw while domain outcomes return, requiring two exhaustive handling paths.                                                      | Necessary Interlock integration | README and service demonstrate both.                                        |

## Metrics

- Lifecycle: **223 lines**.
- Application binding: **134 lines**.
- Prisma driver: **181 lines**.
- Service layer: **57 lines**.
- Unsafe casts in lifecycle, binding, and service: **0**.
- Type assertions in lifecycle, binding, and service: **1** (`Record` input
  narrowing after an object runtime check).
- Explicit Interlock generic sites: **4** (`defineEvent`, `defineLifecycle`,
  `BindingFor`, `ClientFor`).
- Duplicated protocol types: **0**.
- Placeholder binding methods: **0**.
- Request-specific mutable closures: **0**.
- Application reads repeated because of the API: **0**.
- Minimum concepts for a transition: lifecycle, event schema, binding, driver,
  client, actor, expected version, and idempotency key.

The custom driver is generic to Prisma/PostgreSQL; the binding is entirely
permit policy. The integration did not reveal a small, broadly useful core
change that justified altering the alpha API.
