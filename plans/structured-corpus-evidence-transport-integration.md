# Plan: Private structured evidence transport (EP3–EP4)

**Authority:** The existing Evidence contract at Fin `941ad87` and the integration request for a private retained-evidence path across Fin and IK.
**Reference pins:** Fin `941ad876df606884b19aad47a41fdb58ebae0b52`; IK `38ea9423f904573858df0c26a068dfee9225eca0`.
**Goal:** Fin can replay an exact retained row/count grant and page through its frozen supports over the same trusted MCP session, with current access checks and finite response limits.
**Approach:** First freeze the SDK-supported private dispatch, trusted consumer resolver, and persistent-session ownership. Then implement retained `read` and bounded `supports` as two end-to-end capabilities over that dispatch, reusing IK's EvidenceStore and Fin's existing retrieve adapter/session. This plan does not complete Q1–Q13, E1–E15, or M1–M20 acceptance. All implementation and evaluation are assigned to other sessions.
**Spec link:** Fin `specs/structured-corpus-evidence.md`, “Internal evidence capability” and E1–E15; EP3–EP4 in Fin `plans/structured-corpus-evidence.md`.
**Per-ticket loop:** failing-first tests → implementation → typecheck and focused plus real-adapter acceptance → end-of-round `arthurpower:code-review`; if blocked, `arthurpower:review-report-repair` → `arthurpower:verification-before-completion`.

## Current code evidence

- IK already has an optional `EvidenceStore`, narrowed with `supportsEvidenceStore`: `src/core/types.ts:569-648`, `src/core/storage/backend.ts:231-270`. `readGrant(evidenceRef, at)` returns a typed granted/denied outcome and the exact stored grant value/context: `src/core/types.ts:487-557, 605-620`. `listGrantSupports` returns the complete frozen dependency set in UUID order; `listGrantPinnedExtractions` returns issue-time extraction links. Neither API paginates. `SupportRecord` contains source/version/location/span metadata and no display payload: `src/core/types.ts:425-454`.
- PostgreSQL grant creation uses its own checked-out-client transaction: `src/core/storage/pgvector-backend.ts:2049-2063`, `src/core/storage/evidence-pg.ts:167-207`. Replay currently reads through the pool; `readGrantFacts` performs multiple queries and the scope-revision read has no lock: `src/core/storage/pgvector-backend.ts:2066-2073`, `src/core/storage/evidence-pg.ts:477-487, 707-793`. A private read therefore still needs an atomic recheck/fence compatible with authorization and purge writers.
- IK currently registers `retrieve` and `read_source` from its model-facing tool registry and has no `corpus_evidence` dispatcher: `src/index.ts:581-623`. `retrieve` accepts `filters.structured_query` and currently exits as `structured_search_unavailable`; `read_source` returns text slices and is a separate contract: `src/tools/retrieve.ts:117-165, 227-268`, `src/tools/read_source.ts:1-39`.
- Fin's `RetrievePort` carries structured queries but has no retained-evidence read method: `src/fin/retrieve/port.py:386-484`. `MCPRetrieveAdapter.read_slice` calls `read_source`, not a grant read: `src/fin/retrieve/mcp_adapter.py:855-932`. `MCPRetrieveAdapter` can accept a persistent `MCPStdioSession` and send requests through it: `src/fin/retrieve/mcp_adapter.py:724-754, 1314-1362`; the session serializes calls over its existing process: `src/fin/retrieve/mcp_session.py:169-199`. The current `compile_graph` construction passes `command` without sharing a session: `src/fin/host/graph.py:3126-3132`.

## Architecture review gate

The original Evidence plan's all-yes ACR covers the broader evidence lane and remains inherited context; it does not settle this slice's private SDK dispatch, trusted consumer resolution, or process/session lifecycle. Independent focused plan re-review passed all five axes on 2026-10-04 after the boundary/race cases and typed failure mapping were completed. Ticket 1 must still freeze and review its concrete dispatch/identity/session choices before tickets 2–3 start.

```text
bounded-context-guardian: yes — private IK dispatch stays behind EvidenceStore/MCP; Fin consumes the adapter; ticket 1 freezes trusted identity and session ownership.
input-contract-tests: yes — empty/invalid/selectors/versions/size, PG and memory revocation races, duplicates and injected failures are explicit.
error-handling-enforcer: yes — closed failure table, EXIT comments, primary-error preservation and no empty/legacy success fallback.
complexity-anti-drift: yes — dispatch decision, exact read and frozen support paging are separate tickets.
minimal-change-verifier: yes — EP3/EP4 only; no settings, lockfiles, dependencies, CI or release changes.
```

## Existing verification references

These are regression baselines, not EP3/EP4 action acceptance or full Q/E/M acceptance:

- Fin's fresh focused adapter/host/retry tests recorded for the repaired integration checkpoint: 50 passed; they use scripted MCP responses. The eight-file evidence regression passed 521 tests; pyright reported zero errors and warnings. The EP0 map separately records an earlier Fin baseline of 373 passed / 25 deselected.
- The EP0 map records an earlier IK SQL-query baseline of 34 passed. The integration record reports an IK Evidence/PostgreSQL, memory, schema, and bootstrap foundation group of 138 passed at the earlier `a932d5c` checkpoint, plus a hermetic baseline of 2814 passed / 322 skipped. Those counts do not demonstrate a private MCP read or supports action and are not attributed to the current IK pin.
- Current publication checkpoint verification: 2852 passed / 322 skipped in the isolated provider-environment regression; separate real PostgreSQL run 61 passed, zero skipped (29 publication, 25 Evidence, 7 identity). No private action existed in those runs.
- EP0's proposed Fin driver `tests/acceptance/test_structured_evidence_acceptance.py`, its marker, and its command are explicitly not present in the evidence verification map. A future implementer must verify the live harness and record the actual path and command before adding that driver.

## Tasks (ordered by dependency)

1. **Freeze private dispatch, trusted identity, and session ownership** — tag: `[decision]`
   - **Inherits:** “Trusted caller/consumer identity is supplied by the transport, never by the model or a stored scope token”; the capability is carried over the same MCP connection and is not exposed as a second model-facing search tool. (Fin evidence spec, “Internal evidence capability”.)
   - **Surface:** IK's existing MCP server and Fin's existing retrieve adapter/session.
   - **Acceptance:** Record and obtain focused architecture review for an SDK-supported private dispatch route, how the transport binds the trusted consumer identity to the connection, and which host component owns and closes the persistent session used for retrieve and evidence reads. `tools/list` must not expose a new evidence tool. Verify and record the real-adapter acceptance driver's location and exact command; the current EP0 driver entry is only a proposed, absent path.
   - **Completion:** The contract states one transport route, one trusted identity source, and one session lifecycle that a later implementer can exercise without adding a model-visible evidence/search tool.
   - **Dependencies:** Inherited broad Evidence ACR; focused five-axis review above must pass before implementation.
   - Status: [ ] pending

2. **Replay an exact retained row or count grant through Fin** — tag: `[implementation]`
   - **Inherits:** “`read` returns exactly the stored row/count rather than running a query.” It returns the original context and exact value after rechecking required current dependencies; it does not renew the finite reference. Each action is bounded by the 32 KiB envelope and 60-second execution limit; failures are typed and never returned as an empty success. (Fin evidence spec, “Internal evidence capability”; EP3.)
   - **Surface:** IK's EvidenceStore/MCP boundary and Fin's retrieve adapter/host composition.
   - **Acceptance:** A real Fin adapter sends the versioned private `read` action over the same persistent session used by retrieve. IK returns the exact stored context/value or the contract's typed refusal. PostgreSQL checks the grant, trusted consumer authorization, current scope revisions, and all pinned source obligations behind one transaction/fence coordinated with revocation and purge writers; no partial row escapes if any dependency is unavailable. The serialized success/error envelope stays within 32 KiB and the action completes within 60 seconds. A real PostgreSQL + real MCP-process acceptance proves success, expiry, authorization revocation, purge, unresolved dependency, malformed/oversized request, timeout, and backend-failure outcomes; no query is rerun and `tools/list` remains free of a new evidence tool.
   - **Completion:** A retained row and count can be read or refused through the typed Fin adapter on a real MCP session, with exact value/context, linearizable current-access checks, and no expiry renewal.
   - **Dependencies:** Ticket 1; existing IK EP2 storage capability. This isolated grant replay does not wait for Query's full result path; integrating grant issuance into a live Query result remains a separate prerequisite for final E1–E15 acceptance.
   - Status: [ ] pending

3. **Page the grant's frozen supports and resolve selected endpoint support** — tag: `[implementation]`
   - **Inherits:** “Provenance continuation is an evidence read through the existing retrieve/read adapter seam, not another model-facing search tool. It returns at most 8 supports and 32 KiB, binds the same immutable reference and scope, rechecks current access, and expires with the original reference. It neither re-queries current supports nor issues a new retention grant.” A count grant cannot request supports. (Fin evidence spec, “Bounded references and historical reads” and “Internal evidence capability”; EP4.)
   - **Surface:** IK's grant/support storage and private MCP action; Fin's existing adapter/session.
   - **Acceptance:** `supports` pages only the grant's issue-time support and extraction membership in stable UUID order, returning at most 8 descriptors and staying within the 32 KiB serialized envelope. A continuation cursor and selected `support_id` are mutually exclusive; the selected ID must be a member of that grant, including a selected relationship-endpoint display support beyond the inline prefix. The cursor is opaque and bound to the evidence reference, trusted caller/scope, and original expiry. Count grants refuse support reads. Every page rechecks authorization, purge, expiry, and all required obligations under the same transaction/fence as ticket 2; any denied dependency withholds the row. Real PostgreSQL and the real Fin adapter/MCP process prove a row with more than 8 supports, stable continuation, selected endpoint support beyond page one, rejection of a cursor presented with another grant/caller, cursor expiry, count refusal, and no renewal or current-support requery.
   - **Completion:** A row with more than 8 retained supports can be continued and its selected endpoint support resolved through the same live Fin session, or refused with the typed evidence outcome; the complete grant remains indivisible across pages.
   - **Dependencies:** Tickets 1–2 and IK EP1–EP3. M-PUBLISH supplies the accepted active support set when this action is connected to live Query results; that integration does not turn this isolated storage/action proof into final E acceptance.
   - Status: [ ] pending

## Acceptance and closeout

### Required boundary and concurrency cases

Both actions reject absent, empty and ill-typed evidence references; supports
also rejects empty/malformed cursors or support IDs, unknown fields/actions,
mutually exclusive selectors, oversized UTF-8 envelopes and wrong versions.
Numeric negative/overflow classes apply to schema versions, encoded sizes and
internal offset/counter inputs where present, not to opaque reference strings.
Record N/A when the frozen public shape has no such numeric member.

Use deterministic barriers in real PG and memory to race read/continuation with
authorization revocation, purge and dependency loss before and after awaited
reads. The returned outcome must linearize against the coordinated writer and
withhold the complete grant after denial; no unlocked final check followed by
payload emission is acceptable. Concurrent duplicate reads do not renew expiry,
mint grants or mutate publication. Inject storage, transport, timeout and
rollback failures; preserve exact prior authoritative state and cleanup.

### Closed failure mapping

Use `iknow.structured_error` with explicit `error.code`, following the Evidence
spec's Replay and failure section; do not invent a new timeout/error token.

| Trigger | Wire failure |
| --- | --- |
| Empty/invalid fields, unknown action, malformed cursor or illegal selector combination | `malformed_evidence_contract` |
| Unsupported evidence contract/version or unsupported count-support operation | `unsupported_evidence_contract` |
| Unresolved source binding or required bound dependency | `unsupported_source_binding` |
| Complete request/response exceeds its finite envelope | `evidence_too_large` |
| Fixed grant or grant-bound cursor lifetime ends | `evidence_expired` |
| Current trusted consumer authorization denied/revoked | `access_denied` |
| Unknown/purged/unprotected grant | `evidence_unavailable` |
| Backend/network failure or service execution deadline | `backend_unavailable` (service failure, never historical expiry) |

Every refusal, whole-grant withholding, timeout and rollback exit carries an
`// EXIT:` explanation (or the repository's Python equivalent). Preserve the
primary typed error and safe secondary rollback diagnostics. Neither adapter
converts any failure to an empty successful row or legacy result.

Before writing a real-adapter driver, verify the current harness and pin its runnable command. The driver must exercise the actual Fin adapter, the built IK MCP process, one shared persistent MCP session, and real isolated PostgreSQL retained records; an in-process handler or fixture-only test is not acceptance. Record each observed result against both reference pins and report blocked prerequisites explicitly.

These tickets deliver only the EP3/EP4 private transport slice. EP12 stays pending until QP1's approved corpus/oracle, QP10's post-ingest identity map, QP11's measured bounds, required Query and Maintenance outcomes, and every E1–E15 real interaction case are observed passing. After all implementation tickets, run the end-of-round code review; repair any blocked High findings, then run verification-before-completion. CI, settings, lockfiles, issue creation, and release are outside this plan.

**Persist list:** Empty.
