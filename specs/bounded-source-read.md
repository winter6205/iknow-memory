# Spec: bounded company source read

> **Status:** G4 backend projection of fin `specs/thread-attachment-source-read.md` and fin ADR 0088. This repository owns only the company-source MCP read boundary; fin owns thread attachments, source selection, and citations. The complete G4 implementation is not yet landed.

## Objective

Return one stored **资料** source unit in resumable, bounded pieces through the real `read_source` MCP tool so a host never receives the full body on a bounded read. The stored full body remains authoritative; this changes the read result, not the source-document write or retrieve ranking.

## Confirmed decisions and inherited assumptions

1. Fin ADR 0088 fixes the read contract: one versioned unit, zero-based Unicode-code-point continuation, at most 8,000 code points of text and 32 KiB of serialized tool result per call.
2. `source_ref` remains the company source-document identity. Fin serializes its typed `{document_id,version,unit}` locator to the exact canonical `source_ref` string stored at push time; iknow-memory performs exact-key lookup rather than interpreting a new locator object. The existing `id` selector remains an iknow-memory tool selector but does not appear in fin's model-facing typed locator.
3. The authoritative full body stays in **资料**; chunk and search indexes remain derived (iknow-memory ADR 0010).
4. The complete MCP tool result object is measured as UTF-8 JSON, excluding transport-controlled JSON-RPC framing. A host may apply its own smaller budget but cannot recover text that the backend silently omitted.

## Boundaries

- **Does:**
  - Accept `source_ref` xor `id` and optional non-negative integral `position` (default zero) on the existing `read_source` MCP tool. Exact-match the canonical stored `source_ref`, which includes fin's document identity, version, and one-based unit; read only that row without mutating the authoritative body or its derived chunks. Do not reinterpret a typed fin locator inside iknow-memory.
  - Return a contiguous text slice, source identity, and `next_position` (or `null` at end). A non-final successful slice advances; concatenating slices from zero exactly reproduces the stored body, including supplementary-plane Unicode and escaping-heavy content. An empty body returns an empty terminal slice. A position beyond the body is a typed invalid position.
  - Bound text to 8,000 Unicode code points and the complete serialized MCP tool result object to 32 KiB UTF-8 before it leaves the tool. Reject oversized selector metadata as `invalid_locator`; never emit an oversized result or a non-advancing continuation.
  - Keep existing named `read_source_not_found` and `read_source_invalidated` behavior. Invalid positions, storage/transport exceptions, and serialization failures use structured typed errors rather than empty successful text or prose matching. Document failure exits in source-language `EXIT` comments.
  - Add a committed representative source-body gold fixture longer than 8,000 code points, including supplementary-plane Unicode and JSON escaping. Prove the tool against a real PostgreSQL 16/pgvector source-document store and the real MCP process with that fixture. Record the actual persisted identity, returned slices/positions, serialized byte maximum, and reconstruction comparison in a validation artifact before marking this plan done.
- **Confirms with human:** none remaining; the G4 operator selected the limits and continuation unit.
- **Out of this spec:** fin thread attachments, thread ownership or authorization, PDF parsing, search ranking, citation verification, a new source-document authority, and a compatibility route that still returns a full body on the bounded-read path.

## Success Criteria

1. `npm run typecheck` and `npm test` exit 0; pure tests cover empty, invalid, overflow, concurrent, and storage-exception classes without replacing the real-dependency check.
2. A committed gold source body longer than 8,000 code points, containing supplementary-plane Unicode and JSON escaping, is stored in real PostgreSQL 16/pgvector under a canonical company `source_ref`. A second unit or version has a different stored key and cannot be substituted by the read. The real MCP `read_source` call returns one bounded slice per request, positions strictly advance to `null`, and concatenating slices equals the independently stored gold body byte-for-byte after UTF-8 encoding.
3. Every complete serialized MCP tool result object in that real gold run is at most 32,768 UTF-8 bytes and every slice at most 8,000 Unicode code points. The validation record contains actual measured maximums and the observed slice/position sequence, not only a passing test name.
4. Real-store missing and invalidated source cases return their existing distinct typed codes. Negative, non-integral, and beyond-end positions and oversized selector metadata return typed input errors; a storage fault returns a typed unavailable result.
5. A real fin MCP client round-trip consumes the bounded response and reconstructs the same gold body through `next_position` before fin T4 is accepted; a fixture-server protocol smoke alone does not satisfy this criterion.

## Open Questions

(none for the backend read contract; implementation may choose the slicing helper and storage query shape.)

## Inherits / Changes

Quoted from [`docs/CONTEXT.md`](../docs/CONTEXT.md) (exact copy after the G4 glossary update):

- **read_source**: under the selected G4 contract, the MCP tool reads one stored **资料** by exactly one of `source_ref` or `id`, returning a contiguous `content` slice (at most 8,000 Unicode code points and 32 KiB for the complete serialized tool result) with a zero-based code-point `next_position` until the authoritative body is exhausted. Missing or invalidated sources return named failures; this is neither a local-file reader nor a substitute for **retrieve** (fin G4 source-read contract).
- **资料**: the prose system of record — one row is the full body the injector pushed, while **chunk** rows are derived slices. The dashboard may open the body; under the selected G4 contract, MCP **read_source** returns bounded pieces of it while stored authority remains the full body (ADR 0010; fin G4 source-read contract).

**Inherits:** iknow-memory ADR 0010 and existing `read_source` tool/source-document store; fin ADR 0088 and the G4 source-read spec fix the new bound. The existing `specs/mcp-tool-surface.md` full-body wording is historical and needs a G4 supersede note.

**Changes:** the MCP read result is a bounded slice with position, while stored **资料** remains the full-body source of record. No fin attachment state or index is stored in iknow-memory.

## Persisted domain updates

1. **read_source** and **资料** glossary entries updated in `docs/CONTEXT.md`; ADR 0010's storage authority remains unchanged.
2. `specs/mcp-tool-surface.md` now points to this bounded-read contract for its historical full-body response.

## Architecture change reviewer

bounded-context-guardian: yes — only the iknow-memory company source-read boundary changes; fin owns attachments and citations.
input-contract-tests: yes — five input classes, exact canonical `source_ref` mapping, distinct unit/version keys, and a real MCP/PostgreSQL gold case are explicit success criteria.
error-handling-enforcer: yes — misses, invalidated rows, invalid positions, oversized selectors, and storage failure have structured exits.
complexity-anti-drift: yes — slicing belongs in the read tool boundary; storage remains the source-document authority; no new ranker or HTTP route.
minimal-change-verifier: yes — one bounded-read change with no attachment store, ranking, or authorization work; glossary and old-spec pointers are synchronized.

OVERALL: PASS — independent review on 2026-09-24; implementation stays blocked on the named real-gold acceptance.
