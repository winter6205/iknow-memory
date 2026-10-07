# P3-I3 — MP14 atomic mark and reactivation

Status: implementation plan (architecture gate passed)
Builds on: `f6f507d` (MP13, iknow-memory #302) — strictly ordered after P3-I2
Authority: `specs/structured-corpus-maintenance.md` §Physical collection:296-305;
`plans/structured-corpus-p3-prerequisites.md` (fin) rows 4.1 and the §1b register
Target acceptance: driver case **M15** (`tests/acceptance/t07-m1-m20-coverage.test.ts`)

## The one sentence

Collection is mark, wait 7 days, recheck, delete (spec:296). MP13 decides *when* a
payload is eligible. MP14 owns step 1 only: recording that mark **atomically with
the obligations it stops**, and cancelling it atomically on reactivation. It never
deletes — that is MP15 — so candidate time and physical purge time stay two facts.

## Why the mark is its own row and not a `source_versions` column

MP13's candidate is `(payloadClass, payloadRef)`. Six classes exist
(`COLLECTION_PAYLOAD_CLASSES`), and only four are source-bound
(`COLLECTION_SOURCE_BOUND_CLASSES`). A column on `source_versions` therefore
**cannot represent a mark on an attempt stage, a derived generation, a job's
detailed logs, or a snapshot payload**. The mark's identity is the payload's, so
the mark's row is too: `structured_collection_marks` keyed by
`(payload_class, payload_ref)`.

`obligations_stopped_at` stays exactly what it already is — the *effect* on a
source-bound candidate, enforced by `decideGrantRead` (`evidence-store.ts:449-454`).
MP14 writes it; it does not redefine it.

## The expected-revision trap, and how this design avoids it

Spec:307 requires a stale mark to be cancelled or re-evaluated rather than trusted.
A mark records `expected_lifecycle_revision`; recheck compares observed against
recorded, and any difference marks it stale.

The trap: a mark stops new obligations, which is a maintenance-visible change, so
marking **itself** advances `maintenance_revision`. A mark that recorded the
revision it *observed* would therefore be born stale and be cancelled on its first
recheck — a self-inflicted livelock that looks like correctness.

Resolution: the mark records the revision **as it stands at its own commit**, read
inside the transaction and taken after the bump it performs. A mark is then stale
only when something *else* moved after it, which is the condition spec:307 actually
describes.

`maintenance_revision` is carried as a decimal **string**, not a `bigint`: it is
`bigint` in the DDL (`schema-publication.ts:8-9`), and a JS `bigint` cannot cross
`JSON.stringify` — the same reason `authorization_revision` and `purge_revision`
are opaque strings (`schema-evidence.ts:148-153`).

## Reuse, not reinvention

Both lanes compose through the **same** authority the durable-work ledger already
depends on, which is what "reuse the scope UOW's lock order" asks for:

- PG: `AuthorizedScopeUnitOfWork.withAuthorizedScope` (`structured-scope-uow.ts:483`)
  — yields `AuthorizedScopeWork.client` (`structured-scope-types.ts:434-436`), runs
  the unified lock order before the callback, and defers revision bumps to commit.
- Memory: the same interface, yielding `PreparedMemoryScopeWork.prepare`
  (`structured-scope-types.ts:443-445`), over the shared `MemorySerializationPort`
  tail (`structured-scope-types.ts:374-403`).

`PgScopeTransactionRunner.runTransaction` was rejected as the host: it takes **no**
structured locks, so ordering would be left to the caller.

**One asymmetry must be resolved.** The three lifecycle mutators run through
`wrapPgRead` on a **pool** (`pgvector-backend.ts:2229-2232`), so they cannot join
this transaction and "atomically mark … and stop new obligations" would be two
transactions. MP14 adds a client-scoped stamp execution that reuses the existing
closed `STAMP_SQL` map (`evidence-pg.ts:69-73`) — the column name still cannot
arrive from a caller, so the injection-safety property is preserved rather than
reimplemented.

## What MP14 does not own

Deleting anything (MP15), explicit purge (MP16), all-owner completion (MP17),
and the invalidation outbox emission (§1.2, MP16). MP14 records no success about
removal because it removes nothing.

## Files

affects:
- src/core/maintenance/collection-mark-types.ts
- src/core/maintenance/collection-mark.ts
- src/core/storage/collection-mark-pg.ts
- src/core/storage/collection-mark-memory.ts
- src/core/storage/schema-collection-mark.ts
- src/core/storage/schema-lock.ts
- src/core/storage/schema-bootstrap.ts
- tests/core/maintenance/collection-mark.unit.test.ts
- tests/storage/collection-mark-memory.test.ts
- tests/acceptance/maintenance-mp14-mark-pg.test.ts
- plans/structured-corpus-collection-mark-p3-i3.md

`schema-bootstrap.ts` was added to this list during implementation. The DDL is
useless until something calls it: `upSchemaBootstrap` invokes only the
invalidation, projection, maintenance-work and publication modules, so a
`structured_collection_marks` table created but never called would never reach a
deployed store. `schema-bootstrap.ts` is the sole wiring point, and
`tests/storage/bootstrap-tables-indexes.test.ts` enforces that the probe's table
list, the probe's forward-compat column list and the bootstrap's DDL calls agree in
both directions — so the call and the probe arm had to land together.

## Architecture review verdicts

bounded-context-guardian: yes — one new storage pair plus one decision module, both inside the existing `core/maintenance` and `core/storage` boundaries; no technical-layer directory, no import from fin, no sibling bounded context touched.
input-contract-tests: yes — the public entry is a decision plus a writer, covered for empty candidate, invalid payload class, unbound source-bound class, missing anchor, unreadable instant, concurrent reactivation, and a throwing store.
error-handling-enforcer: yes — every refusal reuses MP13's `{refused, code, detail}` shape and the closed `MAINTENANCE_WORK_FAILURE_CODES`; no new magic code, no silent catch, no success recorded on a failed path.
complexity-anti-drift: yes — decision is pure and store-free, storage is one class per lane, the types module holds vocabulary only; one abstraction level per module, no god-file intent, no planned duplication across lanes beyond the twin MP13 already established.
minimal-change-verifier: yes — one logical slice (P3-I3), stacked on MP13; the only edit outside new files is adding one readiness-probe arm to `schema-lock.ts`.

## Ordered work

1. `collection-mark-types.ts` — mark vocabulary, identity, decision and outcome shapes.
2. `collection-mark.ts` — pure: eligibility (delegating to MP13's
   `decideCollectionEligibility`) → mark / reactivate / recheck decisions. No store.
3. `schema-collection-mark.ts` + `schema-lock.ts` — DDL and the readiness arm.
   New table, so no CHECK is widened and the "sixth status" hazard is not entered.
4. `collection-mark-pg.ts` — composed through `withAuthorizedScope`; client-scoped stamp.
5. `collection-mark-memory.ts` — same decisions over the shared tail.
6. Tests: unit (fake clock), memory (incl. the A3 serialization-removal test),
   real PostgreSQL under `MAINTENANCE_ACCEPTANCE=1`.

## The A3 obligation — measured, and its wording corrected

P3-I3 acceptance asks for a test that goes red when **all** serialization is
removed. Measured on this authority, that wording is wrong, and the reason is worth
keeping.

`MemoryStructuredScopeUnitOfWork.attemptAuthorizedRun` (`structured-scope-uow.ts:747-800`)
serializes twice through the tail, but what actually prevents the lost update is
neither of those. It reserves a **routing token** at validation, and the commit
slice re-reads it; a token that moved since validation throws
`ScopeRoutingConflict` and the bounded routing loop retries, which re-reads the
revision and refuses. That is optimistic concurrency, and it is value-based, so it
holds whether or not a mutex exists.

Both sabotage runs, observed:

| Removed | Mutex | Race tests |
|---|---|---|
| `MemoryStructuredScopeTail.exclusive` body | gone | 9/9 still green — invariant unaffected |
| the routing-token re-read in the commit slice | intact | 2 tests red |

So the tests do have teeth; the lever that proves it is the token check, not the
tail. A reviewer who sabotages the mutex will see a green suite and wrongly
conclude the tests are vacuous, which is why the memory lane carries a second race
test that forces the interleave rather than awaiting it: `readMaintenanceInputs` is
wrapped in the test to yield to the event loop *after* the read and *before* the
decision, so both actions are in the same read-to-commit window by construction
rather than by luck. That wrapper is test-side; the store is untouched.

The invariant under test is "one authoritative state wins" — asserted as the two
winners directly, `markStands && reactivationStands`, so a failure names the exact
state it prevents.

