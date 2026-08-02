# ADR 0001: Explicit typed lifecycle builder

The direct `defineLifecycle(definition)` form is available. Applications wanting
callback context inference use `defineLifecycle<Resource, Actor, Context>()`
with event definitions from `defineEvent<Resource, Actor, Context>()`. Mutation
types are inferred per event, while lifecycle states constrain event edges. This
keeps generated declarations readable without recursive graph types.
