# Transaction protocol

Normalization and fingerprinting happen before the transaction. The executor
then claims idempotency, loads and assesses the resource, plans once, applies
the state-and-version update, related writes, history, outbox, and idempotency
completion, then commits. Expected outcomes after a claim use an internal thrown
value so the transaction rolls back before the result is returned.
