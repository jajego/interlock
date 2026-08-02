# Transaction protocol

Normalization and fingerprinting happen before the transaction. The executor
then claims idempotency, loads and assesses the resource, plans once, applies
the state-and-version update, related writes, history, outbox, and idempotency
completion, then commits. Expected outcomes after a claim use an internal thrown
value so the transaction rolls back before the result is returned.

One immutable operation, built from the request snapshot, reaches transaction
options, primary loading, context creation, and write hooks. Write operations
add the event-correlated mutation. Synchronous or asynchronous projections run
sequentially and settle before the primary write.
