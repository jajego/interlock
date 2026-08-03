# Benchmark methodology

These scripts are local regression probes, not package guarantees or marketing
evidence. They report Node, PostgreSQL, Prisma, OS, CPU, pool size, three round
means, coefficient of variation, standard deviation, and range.

## Timing boundaries

The shared benchmark API requires a `prepare()` step that returns the measured
operation. Fixture creation, migrations, seeding, reset, and cleanup run outside
the clock. A regression test proves preparation cost is excluded. Percentiles
use nearest-rank. p99 is omitted below 200 samples so it is not merely the
maximum of a small set.

`serialEquivalentOperationsPerSecond` is `1000 / mean latency`; it is explicitly
not measured throughput. The HTTP benchmark separately runs 100 prepared
requests at concurrency 10 and divides completed requests by wall-clock time.

## Layers

- `benchmark:cpu` uses an in-memory driver and binding. It covers normalization,
  Standard Schema parsing, authorization, guards, projections, JSON snapshots,
  protocol validation, outbox fan-out, duplicate replay, and no-observer,
  no-op-observer, counter-observer, and resolved-promise-observer paths without
  database or HTTP work.
- `benchmark:database` alternates Interlock-first and handwritten-first order by
  round. Both paths use the same input schema, active membership and assignment
  locks, authorization, state/version CAS, history columns, audit, metadata,
  related decision, outbox payload, idempotency protocol, row-count checks, and
  Read Committed isolation. Interlock additionally validates reusable protocol
  boundaries; there is no meaningful handwritten equivalent for that work.
- `benchmark:http` includes parsing, database-backed header authentication,
  service handling, pool wait, transaction work, and response serialization.
  Permit setup and cleanup remain outside timing. The HTTP reference path uses
  its normal structured observer; the direct database comparison does not.

Statement observers execute at every application and Interlock persistence call
inside measured operations. Counts exclude migrations, seed, fixture setup,
cleanup, and Prisma-owned transaction control because Prisma does not expose
`BEGIN` and `COMMIT` through the copyable driver contract. Stable counts are
asserted across samples for normal Interlock, handwritten, and HTTP paths;
separate probes cover duplicate replay, conflict, one outbox row, and five
batched outbox rows.

Pool wait is measured from `$transaction()` invocation to callback entry.
Transaction duration is measured inside the callback. Local loopback, cache
state, CPU scheduling, and adapter behavior still introduce noise. No
performance superiority claim is warranted.

## Local results — 2026-08-02

These are one Windows 10 loopback run on an Intel Core i9-9900K using Node
24.14.0, Prisma 7.9.1, PostgreSQL 16.14, and a pool maximum of 10. CI and the
release target remain Node 26. Results are environment observations, not package
guarantees.

| Database path                   | Samples |      p50 |       p95 |       p99 |     Mean | Round CV |
| ------------------------------- | ------: | -------: | --------: | --------: | -------: | -------: |
| Interlock equivalent approval   |     300 | 42.75 ms | 133.38 ms | 192.29 ms | 60.29 ms |    3.84% |
| Handwritten equivalent approval |     300 | 43.15 ms | 123.99 ms | 154.51 ms | 58.10 ms |    2.50% |
| HTTP submit                     |     300 | 46.93 ms | 207.72 ms | 314.11 ms | 75.98 ms |   34.33% |

The database paths each issued 9 statements. Duplicate replay and version
conflict issued 2 each; five batched outbox rows issued 1; the HTTP submission
path issued 8. Transaction controls are excluded. The database run measured mean
pool waits of 1.37 ms for Interlock and 1.36 ms handwritten, with mean
inside-transaction times of 9.12 ms and 8.98 ms respectively.

The HTTP concurrency-10 run completed 100/100 prepared requests with zero errors
in 989.78 ms, or 101.03 measured operations/second. The large gap between
database transaction time and end-to-end latency, plus the reported variance,
means no performance superiority claim is warranted.

Representative CPU-only p50/p95 results were 0.0129/0.0283 ms for a minimal
transition, 0.0238/0.0752 ms for five outbox descriptors, 0.0783/0.1302 ms for a
64 KiB JSON snapshot, and 0.0078/0.0144 ms for duplicate replay. Each used 150
samples, so p99 is intentionally omitted.

The focused observer probe used 100 warmups and five rounds of 1,000 operations.
No observer, no-op, counter, and already-resolved-promise observers measured
respective p50/p95/mean values of 0.0069/0.0092/0.0080, 0.0086/0.0145/0.0104,
0.0086/0.0099/0.0095, and 0.0083/0.0117/0.0094 ms on Node.js 26.5.0. No network
or filesystem telemetry was included.

## Observer-enabled rerun — Node.js 26.5.0

The final HTTP benchmark used the reference app's normal structured observer.
The direct database comparison constructs the permit service without an observer
and therefore remained observer-disabled.

| Path                                 | Observer | p50      | p95       | Mean     |
| ------------------------------------ | -------- | -------- | --------- | -------- |
| Interlock direct database comparison | disabled | 40.45 ms | 115.53 ms | 52.99 ms |
| Handwritten database comparison      | n/a      | 44.80 ms | 152.65 ms | 64.47 ms |
| HTTP submit                          | enabled  | 55.55 ms | 155.23 ms | 67.15 ms |

The observer-enabled HTTP run completed 100/100 concurrency-10 requests with no
errors at 86.26 measured operations/second. Against the earlier local run, mean
latency improved, p50 increased, p95 decreased, and measured throughput
decreased. Those conflicting movements are within the already documented Docker
loopback variance and do not isolate observer cost. The CPU-only probe is the
appropriate focused overhead comparison.
