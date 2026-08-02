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
types. Protocol objects are now read once into validated snapshots, transition
history is inserted before related writes, and the maintained architecture and
public JSDoc describe the implemented alpha contract.
