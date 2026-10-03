# Plan: Maintenance durable work (MP1–MP4)

**Authority:** [spec](../../fin/specs/structured-corpus-maintenance.md) and
[plan](../../fin/plans/structured-corpus-maintenance.md) in the `fin` repo. This file
is the iknow-side slice of that plan — the durable-work half of maintenance, from `MP1`
through `MP4`. Terminology follows the spec verbatim (work kind, `input_revision`,
attempt, lease, fencing token, typed work failure).

**Baseline:** iknow-memory `sql-business-query-module` @ `eea1e07`.

## Scope of this slice

| Ticket | Outcome | Cross-plan gate |
|---|---|---|
| `MP1` | Record the M1–M20 acceptance driver: exact commands, non-skip exit contract, prerequisites, per-case ticket/invocation map. | QP1's frozen real corpus is still pending, and this slice says so instead of inventing one. |
| `MP2` | One durable job per bound key survives restart; the key binds work kind + source version/generation + `input_revision` + config revision; a query read writes nothing. | none |
| `MP3` | Attempt history is retained; automatic transient retry is capped at 3 attempts with 5s then 30s delays; non-transient failures do not loop. | none |
| `MP4` | Every stage and final write rechecks the live unguessable fencing token, the 5-minute lease, and the complete dependency vector. | none |

`MP5` onward is **not** in this slice. `MP5` needs `E-SOURCE`, `MP6` needs `Q-ID`,
`MP16` needs `EP8`, `MP17` needs `EP9`–`EP10`, and `MP18` needs `QP10`/`QP11`/`EP7`/`EP11`
— all pending in the Query and Evidence plans. The fin plan's own dependency table is the
reason, not a local preference.

## Architecture change review

affects:
- `src/core/clock.ts` (new)
- `src/core/maintenance/types.ts` (new)
- `src/core/maintenance/durable-work.ts` (new)
- `src/core/maintenance/store.ts` (new)
- `src/core/maintenance/service.ts` (new)
- `src/core/storage/schema-maintenance-work.ts` (new)
- `src/core/storage/maintenance-work-pg.ts` (new)
- `src/core/storage/maintenance-work-memory.ts` (new)
- `src/core/storage/schema-bootstrap.ts` (edit: one call)
- `tests/core/maintenance/durable-work.unit.test.ts` (new)
- `tests/storage/maintenance-work-memory.test.ts` (new)
- `tests/integration/maintenance-work-pg.test.ts` (new)
- `tests/acceptance/maintenance-m-acceptance-pg.test.ts` (new)
- `specs/maintenance-durable-work.md` (new)
- `docs/validation/maintenance-m1-m20-acceptance.md` (new)

bounded-context-guardian: yes — the capability is a new sibling of `index_jobs`, not an
extension of it. The spec permits reusing durable storage only "where it satisfies the
contract", and `index_jobs` binds nothing but `(source_ref, content_identity)`: no work
kind, no revision vector, no attempt history. Its own plan calls it an ingest-side
search-index handoff, so it stays untouched and no statement in it changes.

input-contract-tests: yes — the fin plan's boundary table rows for Schedule/retry and
Worker/read leases are implemented as five-class tests per public entry: empty/malformed
key or work kind, negative/overflow attempt and deadline values, duplicate/concurrent
schedule and reclaim, denied caller, and storage fault. Numeric cases use the spec's fixed
counters; revision inputs are opaque strings and are explicitly not coerced.

error-handling-enforcer: yes — a typed work failure is a value, never an empty success.
`MAINTAINANCE_WORK_FAILURE_CODES` covers `invalid_input`, `access_denied`, `input_stale`,
`lease_lost`, `resource_exhausted`, and `backend_unavailable`. Exhausting retries settles
`failed` with its cause; a lost lease is reported, never retried into a false success.

complexity-anti-drift: yes — one lifecycle transition per exported function
(`scheduleWork`, `claimWork`, `heartbeatWork`, `settleWork`, `reclaimExpiredWork`); the
store interface is a flat seam with no generic scheduler; `pgvector-backend.ts` is left
alone rather than growing past 2189 lines.

minimal-change-verifier: yes — one capability, no new dependency, no MCP tool, no fin
wire type, no change to `retrieve` or `push`. Retrieval, source publication, status, and
collection are `MP5`+ and stay out.

## Ticket order

| Ticket | Status | Evidence |
|---|---|---|
| `MP1` acceptance driver record | done | `docs/validation/maintenance-m1-m20-acceptance.md` |
| `MP2` durable job key + restart recovery + query read purity | done | acceptance lane (real PG) + memory twin |
| `MP3` attempt history + bounded retry | done | acceptance lane M7 (real PG) + memory twin |
| `MP4` fencing token, lease, heartbeat, absolute limit, dependency-vector recheck | done | acceptance lane M6 (real PG) + memory twin |

Two findings from the real boundary changed the implementation, not just the tests:

- `PgvectorBackend.search` is the real query read, and the maintenance tables are
  unreachable from it — the query-purity half of M1 is a property of the table boundary,
  not of a code path that could regress.
- The PG claim statement initially carried an unused `$1` placeholder. Only real
  Postgres rejects it (`could not determine data type of parameter $1`); the memory twin
  cannot.

## Non-goals for this slice

Publication/withdrawal of source versions, support sets, `M-STATUS`, projection
dependencies, the collector, and explicit purge are `MP5`–`MP17`. No second fin-side
corpus store, no scheduler, no cross-repository import.
