# `@interlock/conformance`

Exports `verifyTransactionDriver()`, `verifyResourceBinding()`, and
`verifyExecutorAtomicity()` so integrations can execute the protocol's commit,
rollback, transaction-option, handle-lifetime, CAS, and fault-injection checks.

Fixtures own setup and snapshots. Baselines may use any valid version and any
number of related writes; the suites do not assume a fresh version-1 resource.
Run them against real infrastructure before advertising an adapter as
compatible.
