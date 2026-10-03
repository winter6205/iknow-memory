# Spec: maintenance durable work

Status: **Implemented for MP1–MP4 on `feat/maintenance-durable-work`.**
The authority is the fin repo's
[structured corpus maintenance spec](../../fin/specs/structured-corpus-maintenance.md)
and [plan](../../fin/plans/structured-corpus-maintenance.md); this file records how
the durable-work slice realizes that contract inside this package.

## Objective

Persist one logical unit of maintenance work per bound key, hand it to exactly one
worker at a time, fence every write from that attempt behind the attempt's own
credentials, and keep a retry history that explains how the job reached its current
state — across process restarts.

## Boundary

**In scope (MP2–MP4):** the work-kind/revision-bound job key, restart recovery of one
logical job, attempt history, the bounded retry ladder, the worker lease, the
heartbeat, the absolute attempt bound, the unguessable fencing token, and the
dependency-vector recheck on settle.

**Out of scope, deliberately:** publication and support-set compilation (`MP5`–`MP7`),
`M-STATUS` (`MP10`), projection dependencies (`MP11`–`MP12`), the finite collector
(`MP13`–`MP15`), and explicit purge (`MP16`–`MP17`). Each needs a source-lifecycle or
evidence-plan primitive this slice does not own.

**Explicitly not implemented, and not reachable from any entry point here:**

- **Reader leases.** The spec's read side — a query or evidence read finishing
  within 60 seconds or cancelling with a typed timeout, and the 10-minute cursor
  deadline — belongs to the slice that implements the authorized read and
  `M-STATUS` (`MP10`), which is where a reader actually exists.
- **Intermediate/stage writes.** This slice has exactly one write per attempt, the
  terminal settle, plus the heartbeat that renews its lease. There is no stage
  writer, so MP4's "every stage and final write rechecks" is satisfied *for the
  writes that exist*; the stage writer arrives with `MP5`'s staging isolation and
  must route through the same `verifyAttemptGuard`. This is why M4 is only
  partially provable here.
- **The heartbeat cadence itself.** The spec caps a heartbeat at one per minute.
  That is an obligation on whoever runs the heartbeat loop, and this slice ships
  no loop — only the fence it would have to satisfy.

## Why a separate capability, not an extension of `index_jobs`

The spec permits reusing durable storage "where it satisfies the contract". The
index-job ledger binds a job to `(source_ref, content_identity)` and nothing else:
no work kind, no revision vector, no attempt history, no lease token. A maintenance
job must be distinguishable by work kind, so the same key cannot serve both. The
fin plan also calls that ledger an ingest-side search-index handoff and marks the
existing behaviour legacy.

So `maintenance_jobs` and `maintenance_job_attempts` are new tables with a new store
interface. `index_jobs`, `IndexJobStore`, `IndexJobRecord`, and
`submit_index_job` / `poll_index_job` are untouched, and no read path can reach a
maintenance table — which is what makes the query-purity half of M1 structural rather
than a convention.

## Job identity

The primary key is derived from every field the spec requires the key to bind:

| Bound field | Consequence |
|---|---|
| work kind | an `extract_publish` and a `conflict_check` over one source are two jobs |
| source ref, version, generation | a new source version is new work; an A→B→A return still bumps the generation |
| dependency-vector digest | a different dependency set cannot join an existing conflict-check or rebuild job |
| config/ruleset revision | a model or ruleset change supersedes work even when source content is unchanged |

`input_revision` is the SHA-256 digest of the canonical sorted dependency vector
(source, generation, accepted extraction revision, affected relation buckets). Sorting
makes the revision a property of the SET of dependencies, not of the order a caller
passed them; buckets are sorted and deduplicated for the same reason. A missing
extraction revision stays `null` rather than collapsing to `0`, because "nothing
accepted yet" and "revision zero" are different states.

## State and retry

`pending → running → ready | failed | stale`, with `failed` and `stale` re-enterable
through an explicit operator retry.

- **Automatic transient retry:** at most 3 attempts, delayed 5 s then 30 s, then a
  visible `failed`. These are constants, not configuration, so no deployment can
  widen the retry window.
- **Only `backend_unavailable` retries.** Validation and config failures surface
  immediately, and `resource_exhausted` stays a visible typed failure rather than
  being retried into empty output.
- **Attempt history is append-only.** An explicit retry adds attempt N+1 and leaves
  attempts 1..N intact, which is why the record carries `attempt_count` (lifetime, and
  the attempt number) separately from `auto_attempt_count` (consecutive automatic
  attempts since the last explicit retry). The ladder keys off the second.

## Ownership fencing

Each claim mints a fresh unguessable `fencing_token`. The attempt also carries a
5-minute lease and a 30-minute absolute bound.

- **Token first.** A fence that compares the stored token against itself always
  passes, which is the bug a fencing token exists to prevent; the caller must present
  the token its worker actually holds.
- **Absolute bound before lease expiry.** A heartbeat clamps the lease to the absolute
  deadline, so without this order an attempt that ran its full thirty minutes would
  report a reclaimed lease when nothing had reclaimed it.
- **Ownership before inputs.** A worker that lost its attempt has no standing to judge
  staleness; the reclaiming worker owns the job now.
- **Heartbeat extends, never extends forever.** The new expiry is `LEAST(now + 5 min,
  attempt_started_at + 30 min)`.
- **Reclaim is a separate step from claim.** Only `pending` rows are claimable. A
  running row whose lease expired belongs to `reclaimExpiredWork`, which clears the
  token before anybody claims a new attempt. Claiming expired-lease rows directly
  would let two workers each believe they own the job whose previous attempt died.

Settling returns `settled`, `lease_lost`, `timed_out`, or `stale`. The three refusals
stay distinct: collapsing them would hide the difference between a reclaimable lease
and an attempt that must never run again. Input supersession persists `stale` — it is
not a failure and never a success.

## Typed failures

The spec names nine. This slice implements **eight**:
`invalid_input`, `access_denied`, `input_stale`, `lease_lost`, `ruleset_unavailable`,
`resource_exhausted`, `backend_unavailable`, `execution_timeout`. The ninth,
`unsupported_source_binding`, is the source-lifecycle refusal and arrives with `MP5`,
which is where source binding is bound.

A refusal is a typed value, not a thrown error, because a bad request is an expected
outcome of a public entry: the caller must tell `invalid_input` from `access_denied`
without parsing a message. An unnamed actor is refused, never guessed.

A storage fault carries both vocabularies at once: `MaintenanceStoreError` extends
`GraphragError` (this package's convention) and adds `failureCode`, so a worker can
decide whether a fault is worth retrying without parsing an error message.

## Time

Nothing in this capability reads `Date.now()`. Every store method takes the caller's
instant explicitly, and the clock seam (`src/core/clock.ts`) exists so the retry
ladder, the lease, and the absolute bound are provable with a fake clock instead of
sleeping. The collector's day arithmetic (MP13) reuses the same seam.

## Two implementations, one policy

`maintenance-work-pg.ts` is the durable half; `maintenance-work-memory.ts` is the
twin the unit suites run against. Restart recovery is a property of a committed row,
so it cannot be demonstrated against the twin — that case runs on the real boundary.
Both share the same pure predicates (`planSettle`, `verifyAttemptOwnership`,
`verifyAttemptGuard`, `canonicalDependencyRevision`) so the retry ladder and the fence
cannot drift apart. The PG suite re-proves the same behaviours on the real boundary.

## Deliberately absent

No MCP tool, no scheduler, no new fin wire type, no change to `retrieve` or `push`, no
change to `index_jobs`. Querying performs no lifecycle write, and that is a property of
the table boundary rather than of a code path that could regress.
