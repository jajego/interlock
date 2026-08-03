# `@jajego/interlock-conformance`

Development-time verification for custom transaction-driver authors, resource-
binding authors, and integration maintainers. Ordinary application consumers do
not need this package.

## Install

```sh
npm install --save-dev @jajego/interlock-conformance@next
```

Exports `verifyTransactionDriver()`, `verifyResourceBinding()`, and
`verifyExecutorAtomicity()` so integrations can execute the protocol's commit,
rollback, transaction-option, handle-lifetime, CAS, and fault-injection checks.

Fixtures own setup and snapshots. Baselines may use any valid version and any
number of related writes; the suites do not assume a fresh version-1 resource.
Run them against real infrastructure before advertising an adapter as
compatible.

```ts
import { verifyTransactionDriver } from "@jajego/interlock-conformance";

await verifyTransactionDriver({
  driver,
  reset,
  writeMarker,
  markerCount,
  settings,
  probe,
  transition,
  outbox,
  historyCount,
  outboxCount,
});
```

Use the binding and executor verifiers the same way: provide real setup,
operations, and observable snapshots. The package uses Node built-ins and
`@jajego/interlock`; no test framework is required. Node.js 22.14+ is supported.

The committed
[Fastify + Prisma reference application](https://github.com/jajego/interlock/tree/main/examples/reference-app)
uses real PostgreSQL failure and concurrency tests as an external-consumer
evaluation; it is not a production starter kit.
