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

### Concrete shared-authority seam

Add `core/storage/structured-scope-uow.ts` as a storage-owned internal seam,
supplied once by backend composition to publication and screening adapters.
The maintenance service imports only domain contracts; it does not import PG
clients or memory map implementations. The authorized context is created by
trusted server composition/resolution, with `ownerScopeBinding`, `readerBinding`,
`authorizedSourceRefs` and `authorizationRevision`; it is never parsed from model
input. The reader binding selects a view, not another owner lifecycle.

PostgreSQL's `withAuthorizedScope(context, callback)` acquires one pool client,
opens one transaction, locks the owner scope and affected source rows in stable
source order, and validates the authorized source subset. Its callback receives
that same client and a read-only scoped input view. Candidate persistence,
decision records, actual publication membership mutation, work settlement,
revision updates and projection outbox writes all use that client. Callback
success commits once; every refusal/exception rolls back once, retaining safe
secondary rollback diagnostics. Public transaction-owning stores are never
called inside this callback. The existing publication adapter moves its
transaction owner to this shared seam; standalone APIs retain their behavior.

Lock order is shared by all participants: source-ownership reservations in stable
source-reference order, owner scope, affected source rows in stable order, then
work/attempt and membership rows. First owner assignment and all work mutation
paths use the same storage-owned reservation policy. Discover ownership and the
affected source set without write locks, reserve that set, then resolve ownership
again before taking owner/source/job locks. An unowned path remains standalone
only while its held reservation proves that the source is still unowned. If a
scope change requires an unreserved source, roll back and restart before writes;
never acquire an earlier-order reservation while holding owner or job locks.
Permit at most three internal routing attempts; repeated ownership/source-set
change refuses typed `input_stale` without mutation. A live execution deadline
that expires first refuses `execution_timeout`. Preserve typed primary failures
and safe rollback diagnostics on every aborted attempt.
Schedule, claim, heartbeat, settle, retry and reclaim use the same reservation
and owner/source lock helpers before mutating owned jobs.
Global claim first identifies candidate ownership without a job lock, then
attempts nonblocking source reservation and owner/source locks before claiming
and revalidating the job with SKIP LOCKED. Jobs
outside publication ownership retain their standalone behavior. Replace the
scope-after-job progress trigger with the same-client revision hook under these
locks; do not introduce a scope/job lock inversion. Race tests run real claim,
heartbeat, publication and decision paths, not only direct row mutations.

Memory's `withAuthorizedScope(context, callback)` uses one shared serialization
tail supplied to the actual publication, work, identity and Evidence authority.
The callback receives an isolated scoped input view and domain-specific prepared
mutation plans for publication membership, work, screening/decision evidence,
revisions and outbox. All fallible validation and awaited preparation occur
before visibility changes. After preparation, recheck live authority and fences,
then synchronously commit every plan with no await or replace-live-map rollback.
Direct work/identity/Evidence mutations cooperate with that same authority; a
stale copied map cannot overwrite concurrent accepted writes.

Both views expose `readAcceptedInputs(authorizedSourceRefs)` and
`readMaintenanceInputs(authorizedSourceRefs)`. They return only active scoped
sources, exact current subject/support memberships, assertion tuples, current
extraction refs and attributed values, dependency inputs and actual desired/check
work records. Empty/no-hit sources remain in the scoped source view. Required
missing records refuse; no adapter-private copy constitutes authority. A caller
cannot substitute a wider source array than the trusted context.

Status builders consume this view inside the same UOW; the forthcoming Query
adapter will also compile rows/count and issue Evidence grants there. Bind the
reader's revisions to authorized inputs and authorization revision, so hidden
source changes cannot expose counts or invalidate an unrelated reader's view.
Tests inspect the existing publication, identity, Evidence and work stores after
failure, and compare two disjoint reader subsets under one owner to prove shared
authority, rollback and absence of hidden-source leakage.

## Ordered tasks

0. **S0 — Unify actual authority before adding screening behavior** —
   `[implementation]`, depends on the publication checkpoint and architecture gate.
   The bounded first source task owns the shared storage UOW and cooperating
   publication, work, identity and Evidence writers described above. It does
   not yet implement candidates, decisions, or full M-STATUS. The independent
   test engineer first selects `tests/storage/structured-scope-uow-memory.test.ts`
   and `tests/acceptance/structured-scope-uow-pg.test.ts`, with strict command:

   ```sh
   STRUCTURED_SCOPE_UOW_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-scope-uow-pg.test.ts
   ```

   Read-only exploration of publication checkpoint `b4e9af3` confirmed that the
   current progress trigger takes job then scope locks, and publication's guard
   also locks job before scope/source. Introducing the planned scope-first path
   while retaining either writer order creates a deadlock cycle. Tests must use
   actual work settle/claim and publication paths, and prove the shared memory
   tail preserves concurrent identity, work and grant/source writes. Cover first
   owner assignment against schedule, claim, heartbeat, retry, settle and reclaim,
   including an already-running formerly unowned job; repeat in PG and memory.
   Cover two concurrent first assignments, source-set changes during discovery,
   repeated routing changes exhausting the bound, deadline expiry, and injected
   rollback failures. No refused/restarted attempt leaves authoritative writes,
   outbox effects or incorrect revision bumps. S0 passes
   only with those tests, prior publication regressions and strict PG evidence.

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

Initial architecture gate: four yes, one unclear (bounded-context-guardian).
The correction above specifies the shared PG-client/memory prepare-commit seam
and authorized-source read subset. Independent re-review of plan commit
`3f0831f` returned five yes verdicts on 2026-10-04:
bounded-context-guardian, input-contract-tests, error-handling-enforcer,
complexity-anti-drift, and minimal-change-verifier. The architecture gate passes.
Source implementation may start after the verified publication checkpoint;
this verdict is not evidence that screening or full M-STATUS exists yet.
The operator now assigns all implementation and evaluation to other sessions.
This plan is the handoff authority; the integration session performs planning
and review only. Independent source-reservation re-review passed on 2026-10-04
after adding first-assignment races and bounded typed routing exits:

```text
bounded-context-guardian: yes — storage owns reservation-first routing and the same-client revision hook.
input-contract-tests: yes — PG/memory first assignment versus all six work mutations, retry exhaustion, deadline and rollback races are explicit.
error-handling-enforcer: yes — input_stale/execution_timeout, no-mutation exits and primary rollback diagnostics are explicit.
complexity-anti-drift: yes — one shared storage seam centralizes reservations and routing.
minimal-change-verifier: yes — S0 authority/routing is separate from later screening behavior.
```

The corrected architecture gate passes. The future implementation session must
freeze concrete context/input-view signatures and its deterministic test barrier
before writing behavior. No S0 or screening source/tests were written in this
planning turn.
