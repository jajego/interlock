# ADR 0001: Explicit typed lifecycle builder

The direct `defineLifecycle(definition)` form is available. Applications wanting
callback context inference use
`defineLifecycle<Resource, Actor, Context, Mutation>()(definition)`. This keeps
the implementation dependency-free and the generated declarations readable
without recursive graph types.
