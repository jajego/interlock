# Developer-experience audit

This audit compares the immediately previous pre-alpha contract with the new
public API. Counts exclude imports, resource mappers, and SQL bodies.

| Consumer                                   | Before | After |
| ------------------------------------------ | -----: | ----: |
| Minimal required binding members           |      8 |     6 |
| Minimal placeholder methods                |      3 |     0 |
| Minimal explicit lifecycle generics        |      4 |     1 |
| Realistic closure-captured request values  |      2 |     0 |
| Realistic mutation discriminators or casts |      1 |     0 |
| Prisma transaction handles                 |      1 |     1 |

## Minimal PostgreSQL application

Previously the smallest binding still implemented transaction options, an empty
context factory, and a lifecycle-wide mutation. It now omits all three, uses
`primaryRowOnly`, and implements only primary loading, identity extraction, and
one compare-and-swap update. The type-test consumer is the maintained proof.

## Multitenant application

The previous binding received only a resource ID during loading and only a
mutation during writes. Tenant and event identity therefore required closure
state or mutation discriminators. The PostgreSQL example now receives one
immutable operation at loading, context, primary-write, and related-write
boundaries. Event builders preserve each event's input and mutation types.
Transaction-local tenant or RLS settings can run before the primary load.

## Prisma application

The spike still uses one Prisma interactive transaction. The operation reaches
the Prisma binding directly; application model writes and raw Interlock-table
writes share that handle. Interlock does not open a separate `pg` transaction
and no Prisma adapter package is introduced.

## Remaining ceremony

`defineEvent()` is deliberate for events that need strongly correlated input and
mutation inference. `consistency` remains explicit because related-row stability
is an application guarantee, not a safe Interlock default.
