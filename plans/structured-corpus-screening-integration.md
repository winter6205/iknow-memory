# Plan: Structural screening, guarded decisions, and complete maintenance status

**Goal:** Supply MP8, MP9, and the remaining MP10 authority required by a real
structured list/count response. Complete structural screening must never imply
semantic truth or extraction completeness.

**Authority:** The operator's integration request and fin's
`specs/structured-corpus-maintenance.md`, especially Conflict candidates and
readiness, Response status, and Durable work and publication fences. Consume
`plans/structured-corpus-maintenance.md` MP8–MP10 and the accepted publication
integration contract. No production migration, CI, dependency, settings, or
lockfile change belongs to this slice.

**Prerequisite:** Verified publication checkpoint with shared identity, Evidence,
work and publication authority; immutable extraction/display attribution; live
lease/deadline checks. Publication's partial summary is not complete M-STATUS.
Implementation waits for that checkpoint and a five-yes architecture review of
this concrete plan. The current file is a planning draft, not implementation or
acceptance evidence.

**Persist:** Empty. Existing assertion, support, source generation, structural
candidate, decision, and maintenance revision terms retain their normative
meaning. No new cardinality policy or automatic semantic adjudication is added.

## Ownership and composition

One implementer owns the coupled IK maintenance package: pure screen/decision
contracts, PostgreSQL and memory adapters, same-unit-of-work publication hooks,
schema/bootstrap/readiness, and optional backend composition. One independent
test engineer owns the shared parity contract and strict PostgreSQL driver.
They coordinate API signatures before production logic. Other active source
owners finish their checkpoint first; no overlapping source edits are allowed.

Proposed production surfaces are `core/maintenance/screening-types.ts` and
`screening-service.ts`; `core/storage/screening-memory.ts`, `screening-pg.ts`,
and `schema-screening.ts`; the existing publication adapters, maintenance-work
adapters, backend interface/composition, schema bootstrap and schema-lock.
Resolve actual helper seams in the architecture review before implementation.
Reuse the existing identities, accepted membership and work ledger; no private
shadow registry or second source lifecycle is allowed.

PostgreSQL owns one checked-out client and transaction for input snapshot,
attempt fencing, candidate/decision evidence, membership changes, revisions,
status and projection outbox. Memory composes the same actual authoritative maps
through isolated prepare/commit operations, with all validation before commit
and no await between visible mutations. Calling independently transaction-owning
public stores sequentially is insufficient. Existing standalone store behavior
must remain compatible.

Source owner scope and caller read authority remain separate concepts. Trusted
maintenance actors receive server-supplied source permissions. A model cannot
select another actor, owner, authorization set, generation or input snapshot.
Status is filtered to the reader's authorized active sources and must not expose
hidden-source counts or fields. Do not duplicate owner publication state per
reader. Denied actors refuse before writes.

## Ordered tasks

1. **S1 — Freeze the API and failing-first parity driver** — `[decision]`
   Select `tests/acceptance/structured-screening-pg.test.ts` and shared
   `tests/storage/screening-contract.ts` plus `screening-memory.test.ts`.
   Strict invocation is:

   ```sh
   STRUCTURED_SCREENING_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-screening-pg.test.ts
   ```

   Strict mode fails on absent PostgreSQL/capabilities; use a unique schema and
   delete only that schema. Independent expectations use original assertions and
   intervals, not observed backend candidate IDs. The acceptance engineer first
   demonstrates absent behavior as RED, then checks the real API in both stores.
   Boundary fixtures are implementation evidence, separate from the final
   independently reviewed real-corpus M1–M20 golden set.

2. **S2 — Publish immutable structural checks from current guarded inputs** —
   `[implementation]`, depends on S1 and accepted publication.
   Implement `structural-alternatives:1` with an initially empty versioned
   relation catalog. Group by exact canonical head and normalized relation.
   Distinct tails with overlapping half-open intervals produce potential
   alternatives. Null bounds retain explicit unknown/unbounded uncertainty.
   Exact duplicates/multiple origins, disjoint or merely touching intervals, and
   relations explicitly marked multi-valued do not become tail-only candidates.
   No default domain cardinality, confidence threshold or newest-wins policy.

   Candidate identity binds sorted assertion IDs, relevant accepted support and
   extraction/input revisions, ruleset revision and uncertainty. Persist immutable
   check inputs and candidate evidence. A screen publishes only after checking
   the real conflict-check work attempt, live token/lease/absolute deadline,
   desired pair, generation/config and complete affected dependency vector,
   including after awaited work. A stale screen changes neither newer job status
   nor candidates/readiness. A dependency change invalidates old readiness.
   Resource limits refuse the whole check; no partial result becomes ready.

3. **S3 — Persist and apply only explicit current decisions** —
   `[implementation]`, depends on S2.
   Accept decision ID, trusted actor, nonempty reason, exact affected assertion
   and support IDs, expected input revisions, outcome and timestamp. Support the
   normative `keep_both`, `retire_support`, and `supersede_assertion` outcomes.
   Require explicit affected visibility; never infer a replacement or retire an
   undisclosed origin. Validate selected support/assertion membership and current
   authorized inputs in the same transaction. Unknown, denied, stale or ambiguous
   inputs refuse without mutation. Duplicate IDs with identical content are
   idempotent; conflicting reuse refuses.

   Preserve original source/support/extraction and decision evidence. A visibility
   change advances read revision and enqueues affected projection intents
   atomically; `keep_both` cannot silently change current rows. Other sources'
   retained support remains effective. Parallel conflicting decisions cannot
   both apply against the same old input. No user interface or model-driven
   decision maker is included.

4. **S4 — Supply complete same-snapshot M-STATUS** — `[implementation]`,
   depends on S2 and S3.
   Provide exactly the normative maintenance revision, scoped-source/published
   totals, five desired-index buckets, five conflict-check buckets,
   `ruleset_revision` and `coverage: structural_candidates_only`. Each authorized
   active source occupies one bucket in each family, including zero-hit and
   unpublished sources. Desired refresh pending/failed can coexist with a usable
   older published pair. A desired pair that is not yet published cannot inherit
   an old ready screen. First ingest without scheduled work is genuinely pending;
   missing required state refuses `maintenance_status_unavailable`.

   Expose a same-client/unit-of-work read for the upcoming Query and grant slice.
   Progress updates only maintenance revision; changed current data, decisions or
   access update read revision. Heartbeat/progress cannot invalidate pagination.
   No fabricated summary, constant ready flag or independent status transaction.

## Failure and test contract

Use existing closed maintenance failures and typed Query status unavailability.
Preserve primary typed failures and safe suppressed rollback metadata; add EXIT
comments to failure branches. Validate empty/malformed required fields, invalid
UUIDs/types/intervals, negative and unsafe counters, timestamps, missing inputs,
authorization denial, duplicate/conflicting calls, concurrent updates, expired or
backdated attempts and storage/outbox exceptions. An empty accepted assertion
set is a valid completed structural check, not an absent input snapshot.

Required parity scenarios include overlap versus adjacency; null uncertainty;
same assertion/multiple supports; same head/relation with two tails; versioned
multi-value exclusion without modifying the empty initial catalog; exact immutable
candidate identity; current versus stale decisions; shared-origin preservation;
rollback of all authoritative stores/outbox; a dependency update and A-to-B-to-A;
expiry during awaited writes; no-hit/hidden-source status; progress-only revision
changes and changed visibility revisions. Assert prior state exactly on refusal.

After focused GREEN, run whole-package typecheck/build, `lint:s5`, relevant
identity/Evidence/work/publication regressions and hermetic unit tests. Review
Standards and Spec independently before landing; root independently repeats
strict PostgreSQL and memory checks. Record exact commands, counts and cleanup.
No skip counts as acceptance. Final M8–M11 and Q1–Q13 real-corpus acceptance stay
open until actual ingest, backend-ID mapping, measured limits and fin interaction.

## Review status

Architecture gate: pending. No source implementation is authorized by this draft
until the concrete shared-authority seams and five verdicts are recorded.
This is main-session hard integration work, not a ready-for-agent test issue.
