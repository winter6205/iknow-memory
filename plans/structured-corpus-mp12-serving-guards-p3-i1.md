# P3-I1 — MP12 serving guards

Status: implementation plan (architecture gate passed)
Branch: `feat/p3-mp12-guards`, from `5ee8950` (`feat/structured-p1-query-production`)
Authority: `specs/structured-corpus-maintenance.md:320-323`; ticket P3-I1 in
`plans/structured-corpus-maintenance-gc-p3.md`
Target acceptance: driver cases **M13** and **M19**
Independent of: MP13 (collector), MP14 (mark), MP15-17 (deletion) — this branch
stacks on nothing and can merge on its own.

## The one sentence

Before outbox reconciliation, no hit from a withdrawn or sole-purged source may be
returned or cited; a source that still has a current support stays visible; and a
source whose lifecycle state cannot be read refuses serving with a typed status
rather than serving whatever the derived index happens to hold.

## What this branch does NOT assume

A previous reading of the ticket said the attribution join "cannot be built",
because `projection_outbox` records a `subject` uuid with no `source_ref`. That is
true of the outbox and irrelevant here: `chunks` itself carries `source_ref`
(`schema-*`, and it is selected by `buildVectorSearchQuery`), and `source_versions`
carries both `source_ref` and the three lifecycle stamps. The join is a real
join between two tables that both already exist. No new attribution surface is
needed, and none is built here.

## The predicate, and why it is this shape

A source is *served* when at least one of its versions still has a payload that
has not been collected. That single fact covers both halves of the requirement:

- **Withdrawn** — every version of the source is retired, so none is live.
- **Sole-purged** — every version's `payload_collected_at` is set.
- **A current remaining support** — one version with `payload_collected_at IS NULL`
  keeps the whole source visible, which is what the ticket demands and what a
  per-chunk `retired_at` predicate would get wrong by hiding a live version
  because a sibling version was retired.

The check is on **live** source versions, not on the chunk's own validity window:
`valid_from`/`valid_until` decide whether a *row* is current, and a purged
payload's chunks can still sit inside a valid window — which is the whole hazard.

## Fail-closed, and what "fail-closed" costs

`maintenance_status_unavailable` already exists in the closed
`STRUCTURED_ERROR_CODES` vocabulary (`src/core/structured/errors.ts:45`) and is
already marked retryable. If the lifecycle read cannot be completed, this returns
that refusal rather than an unfiltered result set. The cost is real and stated
here: a lifecycle read failure takes vector search down rather than degrading it,
which is the ticket's instruction and the spec's rule for a missing dependency.

## Files

affects:
- src/core/structured/serving-guard.ts
- src/core/storage/serving-guard-pg.ts
- src/core/storage/serving-guard-memory.ts
- src/core/storage/pgvector-backend.ts (the vector predicate only)
- tests/structured/serving-guard.unit.test.ts
- tests/storage/serving-guard-memory.test.ts
- tests/acceptance/maintenance-mp12-guards-pg.test.ts
- plans/structured-corpus-mp12-serving-guards-p3-i1.md

`pgvector-backend.ts` is in scope for the predicate alone. Lexical and graph
adoption is NOT in this branch and is recorded as follow-up rather than claimed.

## Architecture review verdicts

bounded-context-guardian: yes — one pure decision, one storage pair, and one predicate change; no new directory, no cross-repo import, no import from fin.
input-contract-tests: yes — empty candidate set, unknown source ref, every lifecycle combination, unreadable lifecycle state, and a store that throws.
error-handling-enforcer: yes — every refusal reuses the existing closed `STRUCTURED_ERROR_CODES`; no new code, no empty catch, no success on a failed path.
complexity-anti-drift: yes — the decision is a pure function of a facts object; the SQL is one named clause; storage is one function per lane.
minimal-change-verifier: yes — one ticket, one predicate, one guard. The lexical/graph adoption is deliberately excluded and named rather than half-done.

## Ordered work

1. `serving-guard.ts` — pure: candidate source refs + lifecycle facts → serve
   verdict, or a typed refusal when the facts are absent.
2. `serving-guard-pg.ts` — the live-source-ref read, and the SQL clause the
   vector predicate joins on.
3. `serving-guard-memory.ts` — the same decision over a seeded map.
4. `pgvector-backend.ts` — append the clause to `buildVectorSearchQuery`.
5. Tests: unit, memory, and real PostgreSQL under `MAINTENANCE_ACCEPTANCE=1`.

## Honest limits of this branch

- The clause is proven against a real PostgreSQL with real lifecycle rows, and
  against the memory lane, but it is **not** proven through the three-tier
  retrieval assembler, because the lexical and graph arms do not yet consult the
  guard. This branch therefore does not yet satisfy M19's three-tier clause, and
  the register must not be flipped to claim otherwise.
- No tombstone exists (that is MP15/MP16), so the guard keys on the lifecycle
  stamps. Once MP16 lands, a purged source with no version row at all must be
  treated as not-served; the SQL's `NOT EXISTS` shape already does this, and this
  branch tests it.
