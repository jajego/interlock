# `@interlock/core`

Defines typed lifecycle events and executes one atomic transition through an
application binding and transaction driver. It has no runtime dependencies.

```sh
npm install @interlock/core@next
```

```ts
import { createInterlock, defineEvent, defineLifecycle } from "@interlock/core";

const event = defineEvent();
const lifecycle = defineLifecycle()({
  name: "order",
  states: ["pending", "approved"],
  history: { resourceType: "order" },
  events: {
    approve: event({
      from: ["pending"],
      to: "approved",
    }),
  },
});

const orders = createInterlock({ lifecycle, binding, driver });
```

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
