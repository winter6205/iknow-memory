# MP16 — explicit purge transaction (P3-I5)

Base `5ee8950` (`feat/structured-p1-query-production`), branch `feat/p3-mp16-purge`.

Authority: fin `specs/structured-corpus-maintenance.md` §Physical collection (steps 1–4 and
the explicit-purge paragraph) and the M16/M17/M20 rows; fin `plans/structured-corpus-maintenance-gc-p3.md`
§P3-I5; ADR 0097 §2.1/§2.6/§4.1/§4.2.

Scope boundary, stated first so it is reviewable: MP16 is the transaction, the
tombstone-before-delete rule, the `purge_revision` advance, the bounded active-read wait and
the durable fin invalidation emission. It is **not** the payload deletion (MP15) and **not** the
all-owner acknowledgement state machine (MP17). MP16 stops at the outbox emission.

## 1. Architecture gate — `architecture-change-reviewer`

| Verdict | yes/no | Reason |
|---|---|---|
| **bounded-context-guardian** | **yes** | MP16 is a business capability (explicit purge of a structured source), not a technical layer; it sits beside the existing maintenance/publication capability under `src/core/storage/` and composes the existing shared lock-order module (`structured-scope-locks-pg.ts`) instead of re-deriving a second lock policy. No technical-layer directory is introduced and no new bounded context is created, so no context map needs a new entry. |
| **input-contract-tests** | **yes** | The slice adds a public entry (`purge(request)`) with a blank/over-long/missing-field input class, and a new table whose `CHECK`s are the storage-level input contract. Every refusal is exercised against the real database, plus a pure validation unit test for the request shape. |
| **error-handling-enforcer** | **yes** | Every refusal is a `StructuredScopeError` carrying a code from the existing closed `STRUCTURED_SCOPE_FAILURE_CODES` vocabulary; no bare `Error`, no empty catch, no magic code string, and no path that records a completed phase for work that did not commit. A lost write (`RETURNING` with no row) is a typed refusal, not an empty success. |
| **complexity-anti-drift** | **yes** | The transaction body is decomposed into one named step per rule; no new function exceeds 60 lines, cyclomatic 10, 4 parameters or depth 4, and no new file approaches the 1000-line ceiling. `npm run lint:s5` must report every touched function clean. |
| **minimal-change-verifier** | **yes** | No new dependency; no new `MAINTENANCE_WORK_KINDS` member (deliberate, §2.1); the only edits outside new modules are the three registrations the slice genuinely requires (bootstrap call, readiness probe, the one query-read wrap). MP15 and MP17 are not started. |

All five verdicts are `yes`; the gate does not block implementation.

## 2. Decisions recorded (the six fixed, plus the ones this slice had to add)

The six decisions handed down are implemented as given and are restated here so the file is
reviewable on its own:

1. **No new `MAINTENANCE_WORK_KINDS` member.** MP16 is a transaction, not a job kind. This
   avoids a `DROP CONSTRAINT` + `ADD CONSTRAINT` vocabulary migration — the most expensive
   one-way door here, because `CREATE TABLE IF NOT EXISTS` is a no-op on an already-bootstrapped
   database, so a widened vocabulary silently fails on prod while a fresh dev bootstrap stays
   green.
2. **Atomicity from a per-transaction client handle**, not a session-scoped advisory lock.
   Tombstone + revision advance + outbox emission must be one `COMMIT`; a lock serializes and
   cannot make three writes atomic together, and a session lock would pin a connection for the
   whole purge.
3. **Lease registration is scoped to query reads only** — the `structured-query-reads.ts` read
   path, which is where `STRUCTURED_QUERY_READER_LEASE_MS` already governs execution. Evidence
   reads keep their own action bound. Widening to evidence reads touches the whole write path.
4. **`expires_at` is mandatory; there is no heartbeat column.** The row must commit in its own
   short transaction *before* the read begins (a row written inside the read's own transaction
   is invisible to the purge under MVCC), so it survives a reader crash and must self-expire.
   A heartbeat would distinguish alive-but-slow from dead, but the spec already forbids
   alive-but-slow by requiring a read to time out at 60 s, so `acquired_at + 60_000` written
   once is exact.
5. **The bounded wait is bounded by the TTL invariant, not by a timer.** Every lease row expires
   at most 60 s after its own acquisition, so polling to zero terminates even if every reader
   crashed. Consequently lease acquisition and row insertion are one function that no read path
   can call half of.
6. **Cancelling affected work is a fence write, not an expiry wait.** The worker lease is five
   minutes; a purge cannot wait it out. Inside the purge transaction the affected
   `maintenance_jobs` rows lose their `fencing_token`, so the running attempt's next heartbeat
   or settle reports `lease_lost`.

Decisions this slice had to add, with their evidence:

- **D1 — Event granularity is one event per affected grant.** The register
  (`plans/structured-corpus-p3-prerequisites.md` §1b.4) records this as open and says it "must
  not be silently chosen". ADR 0097 §2.1 settles it in evidence rather than by preference: the
  event's `evidence_ref` is defined as *"the invalidated grant's reference only"*, so a per-source
  or per-scope event would have no column to carry. Choosing per-grant because the field forces
  it is not a silent choice.
- **D2 — "Affected grant" = a grant whose support set reaches a purged source, plus the
  scope's count grants.** Row grants are joined through `evidence_grant_supports →
  assertion_supports.source_ref`. Count grants carry no support link by construction (the
  `evidence_grants_arm_check` in `schema-evidence.ts:209-215` forbids dependencies on a count),
  but an explicit purge is exactly the case the spec says still invalidates the count through
  the evidence contract's revision checks, so they are named. A row grant in the same scope
  that does not reach a purged source is **not** named: the scope `purge_revision` advance
  already refuses it at replay, and its content is untouched, so an event would claim a scrub
  that has no cause.
- **D3 — A grant with a blank `consumer_id` gets no event.** `allocateInvalidationSeq` already
  refuses a blank consumer id, and a grant issued before the column existed carries `''`. Such a
  grant is not on any drainable stream, so no event can be published for it; the count of skipped
  references is returned in the outcome rather than swallowed.
- **D4 — The purge tombstone is its own minimal non-content table**
  (`structured_purge_tombstones`), keyed `(scope_binding, source_ref, purge_revision)`.
  Idempotency cannot come from anywhere else: the retry must learn *before* allocating a `seq`
  that the purge already committed, or the per-consumer stream develops a gap that fin's
  contiguity rule refuses. Reusing `structured_publication_sources.active = false` as the
  tombstone cannot answer that question (it records no purge identity), and adding a nullable
  column to an already-deployed table is a forward-compat ALTER plus a probe entry — strictly
  more migration surface than one new table with its own probe entry. This is the only second
  new table beyond the lease table.
- **D5 — The purge transaction also inactivates the source row.** `structured_publication_sources.active`
  is the existing tombstone (`publication-pg.ts:333-342` already calls that write the source
  tombstone) and it is what the scope-read layer already honours, so an explicit purge reuses it
  rather than inventing a second lifecycle flag. Payload rows are **not** deleted: that is MP15.
- **D6 — The bounded wait runs before the purge transaction, and the transaction re-checks it.**
  Waiting inside the transaction would hold the source and scope row locks for up to 60 s and
  pin every writer behind them. Waiting outside leaves a window in which a new read starts; that
  read is refused at grant issuance by the fence that already exists
  (`assertCurrentAuthorization` + the issuance fence), and the same bounded wait is re-run
  before physical removal, which is MP15's call.
- **D7 — The event insert uses `reason = 'purged'`** (`INVALIDATION_REASON.PURGED`), the only
  reason in the closed vocabulary that means an explicit purge; `access_revoked` is an
  authorization change and neither may be read as an expiry (ADR 0097 §2.6).
- **D8 — The lease key is `(lease_id, source_ref)`, not `lease_id`.** This contradicts the
  briefed shape, on evidence. One query read covers the whole authorized source set, so it
  registers ONE lease id against EVERY source it may read; the existing
  `tests/acceptance/structured-query-pg.test.ts` lane failed with
  `duplicate key value violates unique constraint "structured_read_leases_pkey"` against the
  briefed single-column key. The lease id still identifies the reader — the release deletes
  every row carrying it — and the pair keeps each row distinct.

## 2a. Defects this slice's own verification caught

Recorded because each was a real error in the first implementation, not a test artefact:

- The lease `INSERT` had no `RETURNING`, so the "one row per source" guard correctly refused
  every registration. Only a real database reports that; a mock would have agreed.
- `outcome.generation` reported the generation captured at lock time, i.e. the PRE-purge
  value, while the row carried the post-purge one. The transaction now returns the
  generation `UPDATE … RETURNING` produced.
- The `lease_id` primary key above.

## 3. What the code establishes

| File | Contract |
|---|---|
| `src/core/storage/schema-structured-purge.ts` | `upSchemaStructuredPurge(client)` creates `structured_read_leases` (keyed `(lease_id, source_ref)`) with its active-lease index, and `structured_purge_tombstones`. |
| `src/core/storage/structured-purge-pg.ts` | `PgStructuredPurgeStore.purge()` — one transaction: tombstone, source inactivation, `purge_revision` advance, work fence, outbox emission. `awaitActiveReads()` — the bounded wait. `withStructuredReadLease()` — the one function a query read uses to take and release its lease. |
| `src/core/storage/schema-bootstrap.ts` | Registers the new `upSchemaStructuredPurge` in the bootstrap sequence. |
| `src/core/storage/schema-lock.ts` | Names the two tables and the index in the readiness probe, without which an already-bootstrapped database would never receive them. |
| `src/core/storage/structured-query-reads.ts` | Wraps the PG query read in `withStructuredReadLease`, so lease acquisition and row insertion cannot be half-called. |

`tests/storage/bootstrap-tables-indexes.test.ts` derives the expected probe lists from the
statements the bootstrap emits, so it fails if the registration is incomplete.

## 4. Verification planned

- `tsc -p tsconfig.json --noEmit`.
- `vitest run` over the new unit file, the new acceptance file, and the existing
  bootstrap lockstep / query / maintenance-M / outbox lanes.
- Real PostgreSQL: `MAINTENANCE_ACCEPTANCE=1 vitest run tests/acceptance/structured-purge-pg.test.ts`,
  asserting database properties only — two real concurrent transactions, a stale fence token
  actually refused, a repeated purge producing no second revision advance and no duplicate event,
  and a lease row becoming invisible to the wait after it expires.
- `npm run lint:s5`.