---
"@interlock/core": minor
"@interlock/postgres": minor
"@interlock/conformance": minor
---

Redesign the pre-alpha binding API around immutable operation context,
event-correlated mutations, safe defaults, singular structured denials,
asynchronous planning, named clients, curated exports, and schema-qualified
PostgreSQL persistence. This also makes actor and idempotency fields
lifecycle-aware, accepts unbranded adapter versions, constrains event states,
and adds projection operation context plus derived binding and client helper
types.
