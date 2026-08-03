# `@jajego/interlock`

Defines typed lifecycle events and executes one atomic transition through an
application binding and transaction driver. It has no runtime dependencies.

```sh
npm install @jajego/interlock@next
```

```ts
import {
  createInterlock,
  defineEvent,
  defineLifecycle,
  type BindingFor,
  type InputSchema,
  type TransactionDriver,
} from "@jajego/interlock";

interface Order {
  id: string;
  state: "pending" | "approved";
  version: string;
  approvedBy?: string;
}

interface ApprovalInput {
  approvedBy: string;
}

const approvalInput: InputSchema<ApprovalInput, ApprovalInput> = {
  parse(input) {
    if (
      typeof input === "object" &&
      input !== null &&
      "approvedBy" in input &&
      typeof input.approvedBy === "string"
    ) {
      return { success: true, value: { approvedBy: input.approvedBy } };
    }
    return {
      success: false,
      issues: [
        {
          path: ["input", "approvedBy"],
          code: "INVALID_APPROVER",
          message: "approvedBy must be a string.",
        },
      ],
    };
  },
};

const event = defineEvent<Order>();
const lifecycle = defineLifecycle<Order>()({
  name: "order",
  states: ["pending", "approved"],
  history: { resourceType: "order" },
  events: {
    approve: event(approvalInput, {
      from: ["pending"],
      to: "approved",
      mutate: ({ input }) => ({ approvedBy: input.approvedBy }),
    }),
  },
});

function createOrderClient<Transaction>(
  binding: BindingFor<Transaction, typeof lifecycle>,
  driver: TransactionDriver<Transaction>,
) {
  return createInterlock({ lifecycle, binding, driver });
}
```

This abbreviated example leaves persistence as typed function parameters.
Complete runnable integrations:

- [Minimal PostgreSQL example](https://github.com/jajego/interlock/tree/main/examples/postgres-node)
- [Production-style Fastify + Prisma reference app](https://github.com/jajego/interlock/tree/main/examples/reference-app)

The public surface includes `defineLifecycle`, `createInterlock`, typed
`assess()` and `transition()` calls, stable `InterlockError` codes,
version-token helpers, and canonical JSON hashing. Applications supply
persistence through a `ResourceBinding`; no ORM or global registry is included.
Use `BindingFor<Transaction, typeof lifecycle>` for separately declared bindings
and `ClientFor<typeof lifecycle>` at service boundaries.

`transition()` validates runtime input, rechecks policy inside the transaction,
applies the primary compare-and-swap update, and writes history, outbox, and
idempotency records through the supplied driver. `assess()` is advisory and
read-only. Node.js 22.14 or newer is supported.

See the [repository README](https://github.com/jajego/interlock#readme) for the
complete transaction protocol, runnable PostgreSQL example, guarantees, and
limitations.

The reference application evaluates Interlock as an external consumer. It is not
a starter kit or a published Prisma adapter.
