# Idempotency

Claims and transitions share one transaction. A committed duplicate returns its
stored transition identity before current policy is rerun. A rolled-back owner
leaves no claim. There are no leases, polling, expiry, or durable in-progress
states.

The key is scoped by lifecycle and resource ID. PostgreSQL's unique constraint
coordinates concurrent inserts: a competitor waits for the owner's uniqueness
outcome, observes its completed transition after commit, or inserts after owner
rollback. The fingerprint is application-projected from normalized values and
must include every semantic identity component, including expected-version mode.
