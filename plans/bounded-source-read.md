# Plan: bounded company source read (iknow-memory)

**Goal:** The company-source `read_source` MCP tool returns a bounded, resumable slice of one frozen source unit before text crosses the backend wire.
**Approach:** One vertical slice changes the existing tool input, source read, serialized output, and tests together. It is one bullet because this repository owns one backend tool seam; fin owns attachment storage, source selection, and citations.
**Spec link:** [`specs/bounded-source-read.md`](../specs/bounded-source-read.md) (local backend projection of fin G4 contract and ADR 0088).
**Sibling plan:** fin `plans/thread-attachment-source-read.md` T4 consumes this plan's T1.
**ACR:** all five yes for the cross-repository G4 spec (copied below).
**Per-ticket loop (all bullets):** tdd → targeted typecheck and tests. After the bullet, run one code-review phase, repair BLOCKED findings, then verification-before-completion and the project commit rule.
**Golden-set gate:** add the committed long-body gold case and run its real PostgreSQL 16/pgvector plus MCP path, recording actual per-case output under `.claude/rules/test.md`. Missing PostgreSQL or an unrun MCP case blocks completion; the existing retrieval gold set is not a source-read oracle.

bounded-context-guardian: yes — thread attachment indexing stays in fin; company source storage stays in iknow-memory; source-specific adapters cross the boundary.
input-contract-tests: yes — success criteria include empty, invalid, overflow, concurrent, and exception classes, exact source-ref mapping, and cursor failures.
error-handling-enforcer: yes — failure paths map to structured codes, with source-language `EXIT` comments for early returns and fallbacks.
complexity-anti-drift: yes — capability allocation keeps parsing, indexing, and slicing out of HTTP routes and graph nodes.
minimal-change-verifier: yes — one bounded company-read outcome excludes attachments, accounts, permanent ingest, and new ranking; glossary and old-spec pointers are synchronized.

## Settled contract and persist list

- Inherits fin ADR 0088 and G4 spec: company locator `{document_id,version,unit}`; read one frozen unit; first position zero; later position equals prior `next_position`; text ≤8,000 Unicode code points and complete serialized MCP tool result object ≤32 KiB UTF-8 (excluding JSON-RPC framing); only returned text can support fin citations.
- Open for implementation: where to share code-point slicing and response-size measurement within the existing tool/storage boundary. Preserve the source-document authority and retrieval ranking.
- **Persisted:** local **read_source** and **资料** glossary entries updated, and `specs/mcp-tool-surface.md` points to the bounded-read spec. No new ADR is needed because ADR 0010's full-body storage authority stays intact.
- Existing baseline: `tests/integration/read-source-pg.test.ts` exercises a short source through real PostgreSQL but not MCP; `tests/host-smoke.test.ts` launches real MCP with memory storage but does not call `read_source`. The new gold run must combine both boundaries and publish a documented command and actual result record.
- Existing retrieval-gold output and its limits are recorded in [`docs/validation/2026-09-24-g4-planning-baseline.md`](../docs/validation/2026-09-24-g4-planning-baseline.md); it does not close the new source-read gold criterion.

## Tasks (ordered by dependency)

1. **Bound and resume `read_source` on the MCP wire** — tag: `[implementation]`
   - **Inherits:** fin G4 spec: "Enforce the 8,000-code-point text maximum and 32-KiB UTF-8 serialized-result maximum before company text leaves iknow-memory"; ADR 0088 defines zero-based code-point continuation and one versioned unit.
   - **Surface:** iknow-memory source-read tool and company source-document storage boundary.
   - **Acceptance:** add a committed long source-body gold fixture with supplementary-plane and escaping-heavy text, persist it in real PostgreSQL 16/pgvector under fin's canonical `{document_id,version,unit}` `source_ref`, and read it through the real MCP process with optional `position`. Exact-key reads of another unit/version cannot substitute for it; slices carry the same identity and advancing `next_position` or `null`, and joining them reproduces the independent gold body exactly. Every complete serialized MCP tool result object is ≤32 KiB and each text slice ≤8,000 code points; the validation record reports actual persisted identity, slice/position sequence, maximum bytes, and reconstruction result. Invalid/negative/non-integral/beyond-end positions and oversized locator metadata are typed; absent and invalidated sources remain distinct typed exits; backend exception is typed unavailable. Empty source has a terminal empty result. `npm run typecheck` and `npm test` exit 0; fin's live client round-trip also consumes this wire before fin T4 closes.
   - Status: [x] merged to `main` (PR #274, squash `7e4f0d0`) from `feat/g4-bounded-source-read`; the code-review High (byte ceiling now certified on the emitted terminal-cursor form) and the Medium/Low follow-ups are repaired. Measured gold output in
     [`docs/validation/2026-09-24-g4-source-read-gold.md`](../docs/validation/2026-09-24-g4-source-read-gold.md); `npm run typecheck` and `npm test` both exit 0.
     Spec success criterion 5 (fin's live client round-trip) stays open and gates fin T4, not this wire: fin reads `inner["content"]` as one complete body and does not yet follow `next_position`.

## End of round

After T1 lands, run one code-review phase against the fin G4 contract, repair any BLOCKED findings, then run verification-before-completion and commit by the project rule. The fin adapter must consume this bounded wire before fin T4 can finish. No push without operator authorization.
