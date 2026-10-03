# Maintenance M acceptance driver (MP1)

Records the driver `MP1` selected and bound, so a reviewer can tell a measured pass
from a skipped or invented one. Authority: fin
[plan](../../fin/plans/structured-corpus-maintenance.md) `MP1`, spec
[Success Criteria](../../fin/specs/structured-corpus-maintenance.md) M1–M20.

## Selected driver

**Versioned acceptance lane:** `tests/acceptance/maintenance-m-acceptance-pg.test.ts`,
booted through the package's real bootstrap against real PostgreSQL 16 + pgvector.

```
docker compose up -d --wait postgres
MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-m-acceptance-pg.test.ts
```

**Exit-code contract:** `0` only when every enabled case ran and passed; non-zero on
any failure **and** on an unreachable database. This is the one property that had to be
built, because every existing real-boundary suite in this repo
(`index-job-gold-mcp-pg`, `index-job-worker-gold-pg`, `storage-reads-pg`, …) converts a
missing Postgres into a local skip that still exits `0`. A lane that can report green
without running is not an acceptance lane.

| Flag state | Postgres | Result |
|---|---|---|
| `MAINTENANCE_ACCEPTANCE=1` | available | cases run; exit `0` on pass, non-zero on fail |
| `MAINTENANCE_ACCEPTANCE=1` | unavailable | **collection fails**, exit `1`, with the `Validation: - Not run:` block |
| unset | either | lane is inert under `npm test` (skip, exit `0`) |

Both branches were exercised, not inferred — see the measured runs below.

## Why this driver and not an existing one

| Candidate | Verdict |
|---|---|
| `npm run gate:pr` | **Rejected.** With only `gold-set/snapshot.json` on disk it exits `0` by the bootstrap-soft-pass branch. A green false positive. |
| `npm run eval:retrieve`, `eval:stack` | Rejected — retrieval-quality baselines, no lifecycle coverage, and no real boundary. |
| `npm test` (197 files) | Rejected by the plan's own words: regressions never imply live acceptance. |
| the two index-job gold suites | The only existing real-boundary lanes. They cover durability and crash recovery for the legacy ledger, which is explicitly NOT this contract, and they still carry the skip-exits-`0` flaw. |

## Case → ticket → invocation map

| Case | Ticket | Where it runs now |
|---|---|---|
| M1 crash after scheduling recovers exactly one logical job | MP2 | acceptance lane, real PG |
| M1 no query-triggered writes | MP2 | acceptance lane, real PG `search` over the same schema |
| M2 concurrent duplicate schedules join one job (join half) | MP2 | acceptance lane, real PG |
| M6 expired lease invalidates the old token | MP4 | acceptance lane, real PG |
| M7 three transient attempts exhaust into visible `failed`, history intact, explicit retry adds attempt 4 | MP3 | acceptance lane, real PG |
| MP4 a heartbeat cannot extend past the absolute bound | MP4 | acceptance lane, real PG (`LEAST` clamp in the stored row) |
| M4 obsolete attempt cannot publish or alter serving records | MP4 | **Partly** — the fence is proven; there is no stage writer in this slice, and the serving-record half needs MP6's publication |
| M2 (publication half), M3, M5, M8–M20 | MP5–MP18 | **Not runnable.** Blocked on `E-SOURCE`, `Q-ID`, `EP2`, `EP8`, `EP9`–`EP10`, and on `QP1`'s frozen real corpus for the final measured pass |

## Prerequisites

- Real PostgreSQL 16 with `pgvector` (`pgvector/pgvector:pg16`, per `docker-compose.yml`).
- No embedding endpoint, Neo4j, Elasticsearch, or LLM. The query-purity arm uses
  `PgvectorBackend.search` with an explicit vector, so it proves the real read path
  without pulling in a provider the claim does not depend on.
- One throwaway schema per run, plus a `TRUNCATE` of the maintenance ledger before each
  case: claim always takes the oldest pending job in the ledger, so cases would
  otherwise drain each other's work.

## What MP1 does NOT claim

- **No real acceptance corpus is frozen.** `QP1` owns that, and it is still pending. This
  driver therefore proves the durable-work contracts against the package's own schema and
  does not pretend to be the `MP18` measured run.
- `MP18` needs `QP10` (post-ingest IDs), `QP11` (measured bounds), `EP7`, and `EP11`, none
  of which exist. A blocker report is not completion.
- No test path, flag, ID, or command in this record is invented: the only new flag is
  `MAINTENANCE_ACCEPTANCE`, introduced by this slice, and its three states are measured
  below.
- The "crash" in the M1 arm is modelled by closing the scheduling store, not by killing
  a process. Durability is still proven across store instances and pools; a real
  `SIGKILL` arm would prove more, and is the shape `index-job-worker-gold-pg` already
  uses for the legacy ledger.

## Measured runs

Real PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2) with `vector` extension, container
`fin-maint-pg`, revision `feat/maintenance-durable-work` at the durable-work slice.

```
$ GRAPHRAG_MEMORY_DB_URL=postgresql://postgres:postgres@localhost:5432/postgres \
  MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-m-acceptance-pg.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ ... MAINTENANCE_ACCEPTANCE=1 ... 127.0.0.1:5999 (nothing listening)
 Test Files  1 failed (1)
      Tests  no tests
 EXIT=1

$ ... (flag unset, database up)          → 8 skipped, exit 0
$ ... (flag unset, database down)        → 8 skipped, exit 0
```

Supporting regressions on the same revision, against the same real database:

```
$ npx vitest run tests/schema-bootstrap.test.ts tests/storage/schema-bootstrap.unit.test.ts \
    tests/storage/bootstrap-columns.test.ts tests/memory-backend.test.ts \
    tests/storage/index-jobs-memory.test.ts tests/core/index-job.unit.test.ts
 Test Files  6 passed (6)   Tests  164 passed (164)

$ npx vitest run tests/integration/index-jobs-pg.test.ts tests/integration/index-job-gold-mcp-pg.test.ts
 Test Files  2 passed (2)   Tests   40 passed (40)

$ npx vitest run tests/core/maintenance/durable-work.unit.test.ts tests/storage/maintenance-work-memory.test.ts
 Test Files  2 passed (2)   Tests   46 passed (46)
```

The 164 + 40 count matters for the boundary decision: the legacy index-job ledger's
PG integration and MCP wire tests still pass unchanged, which is the evidence that this
slice added a capability instead of rewriting one.
