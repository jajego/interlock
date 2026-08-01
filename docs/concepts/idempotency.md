# Idempotency

Claims and transitions share one transaction. A committed duplicate returns its
stored transition identity before current policy is rerun. A rolled-back owner
leaves no claim. There are no leases, polling, expiry, or durable in-progress
states.
