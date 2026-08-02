# DX findings

Measured after the final hardening pass. One narrow core type correction was
required so a current Valibot schema satisfies Interlock's Standard Schema type
under `exactOptionalPropertyTypes`; runtime lifecycle behavior did not change.

| Finding                                                                                                                                                | Classification                  | Disposition                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| Prisma requires a custom `TransactionDriver` for interactive transactions and raw Interlock-table SQL.                                                 | ORM-specific burden             | Keep in the app; evaluate an optional adapter only after more integrations.  |
| Prisma JSON/raw-row types require normalization at the driver boundary.                                                                                | ORM-specific burden             | Driver owns it.                                                              |
| `BindingFor<Transaction, typeof lifecycle>` and `ClientFor<typeof lifecycle>` are the only explicit Interlock generics outside lifecycle construction. | Necessary Interlock integration | Acceptable and useful.                                                       |
| Exact optional property types require omitting absent input keys rather than passing `undefined`.                                                      | Application policy              | Keep explicit route normalization.                                           |
| `applyPrimary()` intentionally has no transition timestamp; `updatedAt` remains an application concern.                                                | Necessary Interlock integration | Prisma maintains `updated_at`.                                               |
| HTTP authentication is only an identity precheck; active role and related authorization facts must be reloaded and stabilized in the binding.          | Application policy              | Membership and event-specific rows are locked inside the transition.         |
| Prisma has no built-in Interlock adapter, so users own transaction hosting, raw artifact SQL, batching, row counts, and error normalization.           | ORM-specific burden             | Keep the copyable driver local until multiple integrations justify support.  |
| Applying the official self-transactional SQL migration to a dedicated schema needs a small `pg` migration connection beside Prisma tooling.            | ORM-specific burden             | Migration-only; runtime still uses one Prisma transaction.                   |
| Operational failures throw while domain outcomes return, requiring two exhaustive handling paths.                                                      | Necessary Interlock integration | README and service demonstrate both.                                         |
| Submission guards rely on aggregate versioning, including both sides of document reassignment.                                                         | Application policy              | A database trigger increments source and destination in deterministic order. |

## Metrics

- Lifecycle: **161 lines**.
- Application binding: **251 lines**.
- Prisma driver: **301 lines**.
- Service layer: **73 lines**.
- Unsafe casts in lifecycle, binding, and service: **0**.
- Type assertions in lifecycle, binding, and service: **0**.
- Explicit Interlock generic sites: **4** (`defineEvent`, `defineLifecycle`,
  `BindingFor`, `ClientFor`).
- Duplicated protocol types: **0**.
- Placeholder binding methods: **0**.
- Request-specific mutable closures: **0**.
- Application reads repeated because of the API: **0**.
- Minimum concepts for a transition: lifecycle, event schema, binding, driver,
  client, actor, expected version, and idempotency key.

The custom driver is generic to Prisma/PostgreSQL; the binding is entirely
permit policy. The integration found only the Standard Schema type-compatibility
defect above; it did not justify altering the alpha event, transaction, binding,
or driver contracts.

Valibot is used only by this private application as a representative Standard
Schema implementation. It removes custom parser plumbing while preserving
event-specific input and mutation inference; no validation dependency enters an
Interlock package.

The 301-line driver combines two interleaved portions: reusable Interlock/
PostgreSQL protocol work (idempotency, history, batched outbox SQL, row-count
checks) and Prisma-specific work (interactive transaction hosting, tagged SQL,
raw-row conversion, and Prisma error extraction). A numeric split would be
misleading because each persistence method contains both. A real Prisma user
currently owns the whole driver, schema-qualified SQL, transient-error mapping,
and query instrumentation. An optional adapter could remove that repeated work
later, but adding one to the first alpha would imply broader compatibility and
maintenance evidence that this single application does not provide.
