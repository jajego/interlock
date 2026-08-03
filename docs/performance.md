# Performance notes

This is a maintainer-facing record for `0.1.0-alpha.1`, not a product latency
guarantee. Interlock keeps all protocol checks enabled during measurement.

## Methodology

- Command: `pnpm benchmark`
- Environment: Node.js 26.5.0, PostgreSQL 16.14 in Docker Desktop, Windows x64
- Database: fixed, explicitly reset `interlock_benchmark` schema
- Samples: 5 warmups, 25 measured operations, 10 measured concurrency batches
- Repeats: three complete baseline runs and three complete final runs
- Reported percentiles: median of the three run-level values
- Included statements: `BEGIN`, `COMMIT`, and `ROLLBACK` plus every measured
  operation query; migration and seeding are excluded

Windows Docker loopback showed substantial tail and run-to-run variance. For
example, final non-idempotent p50 values were 93.4, 85.2, and 26.5 ms. Query
counts are deterministic; timing differences should be read as local evidence,
not production expectations.

## Sequential results

Times are milliseconds in `p50 / p95 / p99` form. Final mean and throughput come
from the median run. Payload scenarios use structured JSON with exact serialized
sizes.

| Scenario                   |              Baseline |                 Final | Queries | Final mean | Final tx/s |
| -------------------------- | --------------------: | --------------------: | ------: | ---------: | ---------: |
| Non-idempotent, no outbox  |    29.2 / 79.3 / 79.7 |  85.2 / 154.2 / 162.9 |  5 -> 5 |       87.3 |       11.5 |
| First idempotent execution |  30.8 / 100.8 / 108.8 |  79.3 / 135.8 / 135.8 |  7 -> 7 |       88.2 |       11.3 |
| Duplicate replay           |       2.1 / 3.0 / 3.3 |       1.9 / 2.8 / 2.8 |  4 -> 4 |        2.0 |      508.4 |
| One outbox row             |    29.7 / 91.7 / 99.8 |  29.3 / 105.8 / 114.0 |  6 -> 6 |       46.2 |       21.6 |
| Five outbox rows           |   41.5 / 99.6 / 108.1 |  32.8 / 128.7 / 149.9 | 10 -> 6 |       52.4 |       19.1 |
| Twenty outbox rows         |  48.4 / 132.8 / 141.7 |  39.6 / 128.6 / 218.0 | 25 -> 6 |       59.1 |       16.9 |
| Hydration off              |  30.5 / 115.4 / 121.8 |    26.3 / 94.1 / 97.3 |  5 -> 5 |       34.5 |       29.0 |
| Hydration on               |  30.3 / 108.8 / 153.0 |   26.8 / 95.1 / 132.4 |  6 -> 6 |       36.5 |       27.4 |
| Zero guards                |  30.3 / 126.3 / 184.1 |   26.5 / 90.6 / 100.1 |  5 -> 5 |       32.7 |       30.6 |
| One guard                  |    30.4 / 91.7 / 92.1 |  31.0 / 118.4 / 139.9 |  5 -> 5 |       49.0 |       20.4 |
| Five guards                |  30.0 / 137.2 / 198.1 |  30.3 / 116.7 / 183.7 |  5 -> 5 |       48.7 |       20.5 |
| 1 KB JSON                  |  64.6 / 157.2 / 226.9 |  32.9 / 117.9 / 150.4 |  6 -> 6 |       52.6 |       19.0 |
| 64 KB JSON                 | 121.2 / 166.6 / 175.2 | 123.6 / 199.9 / 291.3 |  6 -> 6 |      134.4 |        7.4 |
| 256 KB JSON                |  67.1 / 133.6 / 175.4 |  69.1 / 146.7 / 227.3 |  6 -> 6 |       73.9 |       13.5 |

The 64 KB/256 KB ordering and broad final regressions are further evidence that
this loopback setup is unsuitable for general latency claims. The repeatable
outbox result is the statement reduction: five and twenty rows now use one
outbox exchange.

## Concurrency results

Times are final milliseconds per batch. Throughput counts successful committed
transitions; conflict batches therefore count one success per batch. Duplicate
replays use four statements each after excluding their setup transition.

| Scenario                  |  p50 |   p95 |   p99 |  Mean | Successful tx/s | Queries/command |
| ------------------------- | ---: | ----: | ----: | ----: | --------------: | --------------: |
| First, concurrency 1      | 32.9 |  76.7 |  76.7 |  41.1 |            24.3 |               7 |
| First, concurrency 10     | 67.1 | 234.6 | 234.6 | 110.9 |            90.2 |               7 |
| First, concurrency 50     | 93.2 | 126.5 | 126.5 |  95.2 |           525.3 |               7 |
| Duplicate, concurrency 1  |  2.8 |   3.7 |   3.7 |   3.0 |           330.3 |               4 |
| Duplicate, concurrency 10 |  4.3 |   5.4 |   5.4 |   4.3 |          2304.6 |               4 |
| Duplicate, concurrency 50 | 18.3 |  24.9 |  24.9 |  19.3 |          2586.7 |               4 |
| Conflict, concurrency 1   | 27.4 | 108.5 | 108.5 |  39.5 |            25.3 |            5.00 |
| Conflict, concurrency 10  | 35.6 |  90.5 |  90.5 |  45.6 |            22.0 |            4.10 |
| Conflict, concurrency 50  | 61.8 | 157.5 | 157.5 |  83.3 |            12.0 |            4.02 |

## JSON snapshot microbenchmark

The previous implementation validated and then cloned in separate traversals.
The first one-pass implementation validated and snapshotted once, using special
handling only for `__proto__`. Values are structured objects and arrays, not one
large string. Results are median mean milliseconds across three runs.

| Size   | Two pass | Initial one pass | Change |
| ------ | -------: | ---------------: | -----: |
| 1 KB   |   0.0022 |           0.0012 |   -45% |
| 64 KB  |   0.1302 |           0.0580 |   -55% |
| 256 KB |   0.2906 |           0.2106 |   -28% |

### Lazy error paths

A follow-up benchmark compared the original one-pass snapshot, which allocated
an error-path string for every visited value, with a mutable segment stack that
formats paths only on failure. Seven-run median means showed:

| Runtime    |   Size | Path strings | Path stack | Change |
| ---------- | -----: | -----------: | ---------: | -----: |
| Node 26.5  |   1 KB |       0.0011 |     0.0009 |   -18% |
| Node 26.5  |  64 KB |       0.0592 |     0.0370 |   -37% |
| Node 26.5  | 256 KB |       0.2766 |     0.1885 |   -32% |
| Node 22.14 |   1 KB |       0.0019 |     0.0014 |   -26% |
| Node 22.14 |  64 KB |       0.0856 |     0.0325 |   -62% |
| Node 22.14 | 256 KB |       0.1715 |     0.1297 |   -24% |

The implementation also preallocates arrays. Error messages and paths remain
unchanged.

## Larger evaluations

`pnpm benchmark:evaluate` uses the isolated `interlock_performance_evaluation`
schema.

### Consolidated artifact persistence

A benchmark-only data-modifying CTE combined history insertion, five batched
outbox rows, and idempotency completion. It reduced the artifact transaction
from five statements (`BEGIN`, three operations, `COMMIT`) to three. Across
three runs, current/consolidated p50 values were 30.28/29.43, 30.02/30.50, and
30.96/31.78 ms. There was no repeatable latency improvement.

The prototype was rejected. It would add a cross-driver contract, couple error
classification across three artifacts, weaken operation-level fault injection,
and require a separate honest Prisma implementation for no demonstrated local
latency benefit.

### History indexes

The evaluation seeded 100,000 history rows: 100 resources with 1,000 versions
each. `EXPLAIN (ANALYZE, BUFFERS)` showed:

- version-ordered history used `interlock_history_resource_version_idx` in 0.056
  ms;
- occurrence-ordered history used `interlock_history_resource_idx` in 0.084 ms;
- without the occurrence index, PostgreSQL scanned 1,000 rows through the
  version index, sorted them, touched 32 instead of 5 shared buffers, and took
  0.463 ms.

The occurrence-time index is retained because it materially supports wall-clock
chronology and pagination. No migration change was made.

## Accepted and rejected work

Measured changes:

- PostgreSQL outbox insertion uses parameterized batches of at most 500 rows.
- Caller-owned protocol JSON is validated and detached in one traversal.
- Query-count regression tests cover non-idempotent, first idempotent with one
  and five outbox rows, duplicate, and hydration paths.

Documentation-only guidance:

- use `UPDATE ... RETURNING` instead of routine hydration;
- memoize shared reads only within one request context;
- do not mechanically call advisory `assess()` before `transition()`.

Explicitly rejected:

- consolidated artifact persistence, due no repeatable latency gain and higher
  driver/conformance complexity;
- removing the occurrence-time history index, due a materially worse plan;
- guard parallelism, caches, retries, unsafe modes, fingerprint changes, and
  other unmeasured hot-path refactors.
- one-pass `canonicalHash()` for now: seven-run Node 26 medians improved 1 KB by
  14%, regressed 64 KB by 11%, and improved 256 KB by only 2%; Node 22 gains
  were also uneven. The result was not consistent enough across supported
  runtimes.
- pre-serialized driver payloads, prepared statements, outbox SQL-shape caches,
  and renewed consolidated-persistence work without better end-to-end evidence.

## Adaptability refactor check

A final single-run check after the operation-context and projection refactor
preserved every statement count: minimal non-idempotent 5, first idempotent 7,
duplicate replay 4, one outbox message 6, and five outbox messages 6. Measured
`p50 / p95` values were 25.9 / 84.2 ms, 71.6 / 163.4 ms, 2.0 / 2.4 ms, 79.8 /
477.0 ms, and 59.0 / 108.2 ms respectively.

Synchronous and asynchronous projection scenarios both used five statements.
Their single-run `p50 / p95` values were 58.7 / 161.6 ms and 25.1 / 108.4 ms.
The loopback variance is larger than callback overhead, so this is evidence of
no meaningful regression, not evidence that promises improve latency. Public
type tests compiled in 1.322 seconds on Node.js 26.5.0.

The refactor adds no dependencies. Final package sizes and the complete command
matrix are reported in the release handoff rather than treated as performance
guarantees.

## Single-read boundary refactor check

The final boundary-snapshot and module split retained the deterministic
statement counts recorded above: non-idempotent 5, first idempotent 7, duplicate
replay 4, and one or five outbox rows 6. A Node.js 26.5/PostgreSQL 16.14 run
measured respective p50 values of 67.4, 74.6, 2.1, 91.7, and 116.9 ms.
Synchronous and asynchronous projection scenarios both used 5 statements and
measured 83.7 ms p50. These timings remain within the Docker loopback variance
already documented and are not evidence of a latency change.

The core tarball grew from 20,211 to 23,741 bytes because request and protocol
validation now ship as separate declaration/runtime modules with expanded JSDoc.
PostgreSQL and conformance tarballs remained 8,885 and 6,964 bytes. No runtime
dependency was added. The benchmark harness now passes its isolated schema to
`PostgresDriver`; before that fix, the documented command attempted to write
Interlock artifacts to `public` and could not produce a valid baseline.

## Observer microbenchmark

The reference CPU benchmark compares identical non-idempotent transitions with
no observer, a no-op observer, a counter observer, and an observer returning an
already-resolved promise. It uses 100 warmups and five rounds of 1,000
operations, with no PostgreSQL, network, filesystem, or telemetry backend work.

One Windows x64 run on Node.js 26.5.0 measured:

| Observer         | p50 ms | p95 ms | Mean ms | Mean change from none |
| ---------------- | -----: | -----: | ------: | --------------------: |
| None             | 0.0069 | 0.0092 |  0.0080 |                     - |
| No-op            | 0.0086 | 0.0145 |  0.0104 |                  +30% |
| Counter          | 0.0086 | 0.0099 |  0.0095 |                  +20% |
| Resolved promise | 0.0083 | 0.0117 |  0.0094 |                  +18% |

The absolute measured mean difference was 0.0014-0.0024 ms per operation. This
is a local microbenchmark, not evidence about network telemetry. It confirms
that observation is not free and that the no-observer path remains the fastest
default on mean. The counter and promise ordering falls within microbenchmark
noise and should not be treated as a general ranking.

The final Node.js 26.5.0 reference-app HTTP benchmark enabled the lightweight
structured observer and measured 55.55 ms p50, 155.23 ms p95, 67.15 ms mean, and
86.26 concurrency-10 operations/second with 100/100 successes. The direct
database comparison remained observer-disabled and measured 40.45 ms p50 and
52.99 ms mean for Interlock. Mixed changes versus the earlier loopback run do
not isolate observer impact; the focused CPU benchmark above does.
