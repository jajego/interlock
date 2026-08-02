# `@interlock/core`

Defines typed lifecycle events and executes one atomic transition through an
application binding and transaction driver. It has no runtime dependencies.

The public surface includes `defineLifecycle`, `createInterlock`, typed
`assess()` and `transition()` calls, stable `InterlockError` codes,
version-token helpers, and canonical JSON hashing. Applications supply
persistence through a `ResourceBinding`; no ORM or global registry is included.

See the [repository README](https://github.com/jajego/interlock#readme) for the
complete transaction protocol, runnable PostgreSQL example, guarantees, and
limitations.
