# Plan: Structured corpus query execution handoff

**Goal:** Deliver QP5, QP6, QP7, QP10, and QP11 over the authorized published knowledge base, with independently checked corpus IDs and measured contract limits.
**Authority:** Fin `specs/structured-corpus-query.md` and its Query plan own the request, result, identity, visibility, pagination, count, and error contracts. Fin's Evidence and Maintenance specs own grants and maintenance state; the IK integration plans provide the shared storage and transport prerequisites.
**Reference pins:** Fin `941ad876df606884b19aad47a41fdb58ebae0b52`; IK `38ea9423f904573858df0c26a068dfee9225eca0`.
**Baseline:** At these pins, IK validates a structured request and returns `structured_search_unavailable`; Fin transports the optional typed request and returns that refusal when IK supplies no `structured_result`. These pins demonstrate the current unavailable producer boundary, not working list/count behavior or runtime acceptance.
**Approach:** First settle the trusted reader resolver and choose a strict real-service acceptance driver before writing query behavior. Then implement first-page reads, revision-bound pagination, and exact counts on one authorized read unit of work; independently freeze backend-assigned IDs after approved real ingest and measure the same executable path against only the SPEC's limits. The query path waits for shared scope/UOW, full M-STATUS, and EP4 private evidence support continuation.
**Spec link:** Fin `specs/structured-corpus-query.md`; Fin `plans/structured-corpus-query.md` QP5–QP11; Fin `specs/structured-corpus-evidence.md`; Fin `specs/structured-corpus-maintenance.md`.
**Per-ticket loop (implementation tickets):** failing-first test → implementation → focused typecheck and real-boundary tests → `arthurpower:code-review`; if blocked, `arthurpower:review-report-repair` → `arthurpower:verification-before-completion`.
**Execution ownership:** This file is a planning/review handoff. Implementation and external test runs belong to other sessions. No CI, settings, lockfile, issue, or release changes are part of this plan.

## Corpus and acceptance boundary

QP1 remains pending. The primary corpus must be approved, generic public knowledge-base material such as technical references, institutional/encyclopedic material, and policy sources; it must not be finance-primary or project-primary. The local candidate packet remains a draft until rights, original-input hashes, extraction/parser configuration and revision, units, and an independent fact/source oracle are reviewed. Do not treat it as an approved acceptance corpus or turn its current extraction into expected truth.

Expected facts, source locations, lifecycle outcomes, and result-to-source correspondence are authored from the approved originals. QP10 records backend-generated IDs only after real ingest; it never derives IDs from text, query results, or a changed expected oracle. Existing financial fixtures remain legacy regressions only. QP5–QP11 evidence is not a Q1–Q13 full-gold pass; the final QP9 interaction boundary also depends on QP1, QP8, EP5–EP11, and their owning plans.

## Prerequisite route and review status

The query execution slice is downstream of the IK shared-authority plan in `plans/structured-corpus-screening-integration.md`: a trusted server-resolved reader context, stable source-reservation/lock order, one PostgreSQL transaction and equivalent memory unit of work. It also requires the complete MP10 summary from that plan and the private EP4 frozen-support continuation from `plans/structured-corpus-evidence-transport-integration.md`. The publication capability in `plans/structured-corpus-publication-integration.md` supplies current accepted membership, attributed display values, and separate data/maintenance revisions, but its partial summary is not MP10.

The broad five-yes architecture review in Fin's original Query plan is inherited design context only. It did not review this focused shared-reader transaction, owner/read-scope split, live grant issuance, or the private evidence transport. The screening source-reservation correction and private Evidence transport plan have each passed fresh five-axis plan review. Their implementation remains pending. Independent focused review of this Query plan passed all five axes on 2026-10-05; this is a planning gate, not Query behavior acceptance.

```text
bounded-context-guardian: yes — server composition resolves trusted readers; storage-owned UOW supplies data/status/grants and isolates the reader subset.
input-contract-tests: yes — explicit PG/memory empty/invalid/numeric/overflow/concurrent-revision and injected failure cases.
error-handling-enforcer: yes — closed typed failures, EXIT explanations, primary-error preservation and no legacy/partial/empty success.
complexity-anti-drift: yes — first page, cursor and count are separate outcomes with bounded responsibilities.
minimal-change-verifier: yes — QP5–QP7/QP10/QP11 only; no CI, settings, lockfiles or broader acceptance claim.
```

**Implementation gate:** No QP5/QP6/QP7 query behavior starts until the focused five-axis review is resolved to yes or N/A with reason and the shared-UOW, full-MP10, and EP4 prerequisites are available. The first decision below records the actual acceptance driver and invocation; the current suggestion is only a proposal. A strict IK PostgreSQL acceptance path plus a real Fin→MCP→IK interaction run is a candidate shape, but its path, command, isolated-schema lifecycle, and case ownership must be chosen and recorded against the live harness before behavior work. Fixture-only transport tests and memory parity remain supporting evidence, not real-boundary acceptance.

**Persist list:** Empty. This plan reuses Query, Evidence, Maintenance, authorized-reader, and publication terms already defined by their specs and plans.

## Tasks (ordered by dependency)

1. **Select the trusted reader contract and real Query acceptance driver** — tag: `[decision]`
   - **Inherits:** “The backend derives authorization scope from the trusted caller; the model cannot send `scope_binding` or `queried_at`, select another identity, or widen access.” “Each request reads query data, count, and the maintenance metadata it returns from one consistent transaction.” (Fin `specs/structured-corpus-query.md`, Request and List, revision, cursor, and count.)
   - **Surface:** IK's trusted MCP/server composition and storage-owned scoped read boundary; the existing Fin retrieve port and MCP interaction boundary.
   - **Acceptance:** Record how the trusted server resolves caller identity into an owner binding plus only that reader's authorized source subset; model input cannot choose the owner, reader, sources, or revision. The selected read unit of work supplies one transaction/serialized memory view for current membership, exact identities and attributed displays, full MP10, and Evidence grant issuance/receipt creation. It reuses the existing retrieve boundary and EP4 private evidence action; it adds no model-visible search/evidence tool and reports no hidden-source counts. Select and record a strict driver path, exact invocation, isolated PostgreSQL schema/data lifecycle, and owner for each real interaction case before behavior tests are written. A missing PostgreSQL capability must fail the strict run rather than skip green.
   - **Completion:** Focused reviewers and implementers share one recorded trusted-reader, transaction, and driver contract; the driver invocation exercises a real PostgreSQL boundary and a real Fin/MCP/IK interaction for observable query results.
   - **Dependencies:** Fresh focused ACR; the shared-authority/source-reservation review and contract in `plans/structured-corpus-screening-integration.md`; EP4 dispatch and authorization in `plans/structured-corpus-evidence-transport-integration.md`.
   - Status: [ ] pending — plan ACR passed; concrete reader resolver and driver choice remain open.

2. **QP5 — Return the first authorized current page with attributed values** — tag: `[implementation]`
   - **Inherits:** “Only rows with at least one active, non-withdrawn support from the currently published `(source_version, extraction_revision)` pair are in the current query result.” “Among the entity's current authorized accepted supports, choose the smallest distinct `(name, type)` pair by UTF-8 byte order; within that pair choose the smallest support UUID.” (Fin `specs/structured-corpus-query.md`, Result identity and current visibility.)
   - **Surface:** IK's existing structured retrieve path, persistent identity, publication, maintenance-status, and Evidence capabilities; the existing Fin retrieve boundary for interaction proof.
   - **Acceptance:** On one authorized snapshot, list emits each current entity UUID or exact normalized assertion-tuple UUID once in ascending UUID-byte order, applies exact AND filters and only the specified one-hop direction, and applies no implicit wall-clock validity filter. Membership comes only from active supports of the published pair; a pending desired replacement does not hide the currently published pair. Entity and relation-endpoint display selection, disagreement flags, exact display filters, and selected display-support IDs follow the SPEC and use only supports visible to this reader. Each row has the mandatory finite Evidence grant, matching expiry, at most eight stable provenance supports, and truthful continuation state; EP4 can read the selected display support. The response includes the complete same-scope MP10 object from the same unit of work. The server returns at most 20 rows, respects the independent 32 KiB request/response envelope limits at row boundaries, and refuses an irreducible oversized mandatory row with `result_too_large`. Missing/inconsistent status or required evidence refuses with its typed code; there is no legacy fallback or empty success. Verify PostgreSQL and memory parity, including duplicate supports, shared origins, replacement/withdrawal, deterministic conflicting displays, hidden-source isolation, and future/past validity.
   - **Completion:** An approved-corpus first page matches the independent QP1 oracle and QP10 ID mapping, its evidence grants reveal the selected supporting values through EP4, and its status and data share one authoritative read.
   - **Dependencies:** Task 1; QP3/QP4; EP1/EP2/EP4; MP6 and complete MP10; the shared reader UOW. Fin interaction proof also requires the typed QP8 transport. The detailed normative cases remain in Fin `plans/structured-corpus-query.md` QP5 and Q1–Q6/Q12–Q13.
   - Status: [ ] pending — current IK producer is unavailable at the reference pin.

3. **QP6 — Continue pages within one authenticated data revision** — tag: `[implementation]`
   - **Inherits:** “A cursor binds normalized query, subject, access scope, and `read_revision`.” “The cursor expires 10 minutes after the first page; continuation does not renew the expiry.” “Maintenance progress has a separate `maintenance_revision` and does not invalidate list pagination.” (Fin `specs/structured-corpus-query.md`, List, revision, cursor, and count.)
   - **Surface:** IK's existing structured retrieve continuation and the shared authorized read boundary.
   - **Acceptance:** Across more than 20 rows, pages are complete, duplicate-free, and globally ordered by UUID bytes. An authenticated cursor binds normalized predicates, subject, trusted reader scope, and the opaque data revision; its fixed ten-minute deadline begins on page one and never renews. Every continuation rechecks current permissions and query/data revision. Tampering, wrong scope/query, expiry, authorization changes, and data-revision changes produce the SPEC's exact typed outcomes. Maintenance-only progress may return a newer maintenance object without changing `read_revision` or invalidating the cursor. Each read observes the 60-second server lease; pages stop only at row boundaries under 32 KiB and never silently truncate required provenance. Exercise revision races for display-only changes, source publication, support visibility, and authorization in real PostgreSQL, with memory parity for the same contract.
   - **Completion:** A real authorized caller consumes every ID in a multi-page approved result at one data revision, or receives the specified typed restart/refusal on expiry, scope/query change, data change, or revocation; maintenance-only progress preserves the cursor.
   - **Dependencies:** QP5, Task 1, complete MP10, shared reader UOW, and EP4 for bounded provenance continuation. Detailed cases remain in Fin Query QP6 and Q7/Q9/Q10.
   - Status: [ ] pending.

4. **QP7 — Return exact distinct counts and bounded same-snapshot receipts** — tag: `[implementation]`
   - **Inherits:** “It computes the exact number of distinct current authorized stored-subject IDs in one consistent read revision, including zero.” “A count request may carry the current `read_revision` returned by list so the two operations use the same data revision; a stale revision returns `read_revision_mismatch`.” (Fin `specs/structured-corpus-query.md`, List, revision, cursor, and count.)
   - **Surface:** IK's existing structured count path, shared authorized read boundary, and Evidence grant capability.
   - **Acceptance:** Count applies the same exact predicates and scope as list across the complete published current set; it counts distinct stored-subject IDs, never page rows, support rows, or top-k results, and returns exact zero as a successful count. Count rejects list-only `limit` and `cursor`. A supplied `read_revision` is an exact, nonempty opaque string and count-only; the returned token is never parsed or numerically coerced, and stale input refuses as `read_revision_mismatch`. Count, query digest, trusted scope, data revision, full MP10, and bounded `stored_structured_subjects` count receipt/Evidence grant are produced from the same authoritative transaction or memory unit of work. No partial count escapes on timeout, overflow, inconsistent status, unavailable evidence, or response-size failure. Verify zero, more-than-one-page cardinality, repeated/multi-origin supports, visibility changes, stale revision, and oversized receipt against an independently authored ID oracle on real PostgreSQL; keep memory tests as parity evidence.
   - **Completion:** The count and receipt equal the independently mapped distinct current IDs at the reported scope/data revision, including zero, while all failures return only their exact typed refusal and no partial value.
   - **Dependencies:** QP5 and Task 1; QP4; EP2; MP6 and complete MP10; shared reader UOW. The fin replay/admission boundary remains EP5–EP11 and is not claimed by this ticket. Detailed cases remain in Fin Query QP7 and Q8–Q10.
   - Status: [ ] pending.

5. **QP10 — Freeze backend-assigned IDs after approved real ingest** — tag: `[decision]`
   - **Inherits:** “Freeze the mapping from original inputs to backend-assigned persistent IDs in a separate fixture manifest; these UUIDs cannot be computed from source text.” (Fin `specs/structured-corpus-query.md`, Acceptance prerequisites.)
   - **Surface:** The shared QP1 acceptance pack across IK identity, immutable source/support persistence, and accepted publication.
   - **Acceptance:** After the QP1-approved generic public knowledge-base inputs are ingested and published, capture the backend-assigned entity, exact assertion-tuple, and support IDs alongside source references, source versions, extraction revisions, and canonical tuples. Independently review every mapping against the unchanged original fact/source-location oracle. Keep ID mapping separate from expected facts; never use query output to author expected IDs or facts, and never rewrite the oracle to fit backend output. Record the manifest revision/hash and review. A mismatch blocks the mapping and downstream real-corpus acceptance.
   - **Completion:** A versioned, independently reviewed mapping links every approved expected result and support to persistent backend IDs and can be reused unchanged by Query, Evidence, and Maintenance acceptance.
   - **Dependencies:** QP1 approval; QP3; EP1; MP6. This is independent of QP5/QP6/QP7 implementation and blocks only corpus-backed expected-ID checks and QP11/final gold until complete.
   - Status: [ ] pending — QP1 corpus rights, extraction inputs/revision, and oracle approval remain open.

6. **QP11 — Measure real query behavior against the frozen resource bounds** — tag: `[implementation]`
   - **Inherits:** “The complete UTF-8 encoding of each structured-query request and each `structured_result` or `structured_error` response envelope ... is capped independently at 32 KiB.” “A server reader lease lasts at most 60 seconds per request.” (Fin `specs/structured-corpus-query.md`, Request and List, revision, cursor, and count.)
   - **Surface:** The selected strict acceptance driver over IK's real PostgreSQL query boundary and the existing Fin retrieve/MCP path.
   - **Acceptance:** Run the QP1 originals and independent boundary cases through the executable path after QP10 freezes actual IDs. Record exact invocation, per-case expected/observed IDs and counts, request/response UTF-8 byte sizes, page and provenance continuation behavior, count receipt size, and observed reader duration. Demonstrate successful envelopes below the contract cap, row-boundary reduction, typed `result_too_large` when mandatory fields or a row cannot fit, and `query_timeout` for an expired reader lease. Measure the existing 60-second bound and other SPEC limits only; introduce no additional performance thresholds. Real PostgreSQL and the real Fin/MCP/IK process path are required; mocks, memory, or a fixture MCP server are not substitutes. Missing dependencies or an unrun measurement leave this ticket pending, not skipped-green.
   - **Completion:** A reviewer can reproduce the recorded real-path run and confirm each specified request/response/time bound from observed output; violations or missing cases remain open.
   - **Dependencies:** QP5/QP6/QP7; QP8 typed transport; QP10; EP4; Task 1's accepted strict driver. QP1 and the independent mapping must remain unchanged during the run.
   - Status: [ ] pending.

## Closeout boundary

### Boundary and failure obligations

The first decision must assign applicable empty/malformed request or trusted
context, invalid IDs/filters, negative/unsafe numeric limits and counts, and
overflow/UTF-8 envelope cases to PostgreSQL and memory drivers. Use the existing
request-conformance cases for the closed parser; do not duplicate a mirror of
its implementation. Concurrent publication, decision, support/display change,
authorization revocation and maintenance-only progress must exercise actual
shared stores. Inject grant/storage errors and deadline expiry after
awaited reads and before emission; no refused transaction leaves a grant,
receipt, partial count or visible revision change.

Use the original Query spec's closed codes and retryable flags unchanged:

| Condition | Required outcome |
| --- | --- |
| Malformed or unsupported request fields/types/operators/versions | QP4's existing specific closed validation code |
| Trusted reader denied | `authorization_denied` |
| Cursor malformed or authentication fails | `invalid_cursor` |
| Fixed cursor expiry | `cursor_expired` |
| Query, access scope or data revision differs from cursor | `cursor_revision_mismatch` (current permission denial remains `authorization_denied`) |
| Requested count read revision is stale | `read_revision_mismatch` |
| Mandatory row/response cannot fit | `result_too_large` |
| Complete count cannot be obtained | `count_unavailable` |
| Reader execution lease expired | `query_timeout` |
| Required maintenance snapshot missing/inconsistent | `maintenance_status_unavailable` |
| Structured backend/grant capability unavailable or backend operation fails | `structured_search_unavailable` |

Private retained reads keep their separate Evidence failure vocabulary; never
replace it with a Query code. Add EXIT explanations to refusal/rollback paths,
preserve primary typed errors and safe secondary rollback diagnostics, and never
turn a failure into legacy results, a partial result or an empty success.

These tickets deliver only the Query execution and measurement handoff named above. They do not close QP1/QP2, QP8/ QP9, E1–E15, M1–M20, or the complete Q1–Q13 real-corpus golden boundary. Final full acceptance requires the approved originals/oracle, complete MP10, EP4 and downstream Fin evidence admission/replay/invalidation, QP10, QP11, and the remaining Query/Fin interaction cases to pass on one identified candidate. Any status report must separate passed implementation regressions from blocked, not-run, or full-gold cases.
