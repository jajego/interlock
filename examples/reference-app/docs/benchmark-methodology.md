# Benchmark methodology

The three scripts report separate layers and JSON output. They are local
regression probes, not package guarantees.

- `benchmark:cpu` uses an in-memory driver and binding. It includes command
  normalization, parsing, authorization, guards, projections, JSON snapshots,
  protocol validation, and result construction. It excludes database and HTTP.
- `benchmark:database` compares one real Interlock approval with a handwritten
  Prisma transaction providing the same policy, CAS, related decision, history,
  idempotency, and outbox guarantees. It does not compare against one `UPDATE`.
- `benchmark:http` runs the Fastify server on an ephemeral local port and uses
  Node `fetch`. Permit setup is outside the timed request.

Each report includes warmups, sample count, p50, p95, p99, mean, throughput,
three independent round means, coefficient of variation, Node, OS, and CPU.
Database output also identifies PostgreSQL and Prisma. Transaction-control
statements are included in documented query counts; migrations and seeds are
excluded. Docker Desktop loopback, CPU scheduling, Prisma pool behavior, and low
sample counts create substantial variance. Run multiple complete rounds before
drawing conclusions. No latency-injected result is generated automatically; use
a documented network proxy when evaluating round-trip sensitivity rather than
adding networking machinery here.

The database comparison deliberately reports the production permit approval path
only. Its statement counts are audited from the fixed operation structure,
including transaction control, rather than collected by a query-hook that could
change adapter behavior. Duplicate, conflict, payload-size, lock-contention, and
concurrency sweeps remain future benchmark work; this harness must not be cited
as evidence for those scenarios. The CPU layer covers duplicate replay, outbox
fan-out, guard count, and JSON size independently.
