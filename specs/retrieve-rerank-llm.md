# Spec: Retrieve LLM rerank (temporary main-model adapter)

> **Status:** draft → ACR in this file.
> **Source:** operator 2026-08-27 — temporary substitute for a dedicated rerank model is the **extract Anthropic main model** (same key/model/base URL), not the Host chat model, not a cross-encoder HTTP sidecar in this slice.
> **Predecessor ranking:** `specs/retrieve-graph-priority.md` (Host list before rerank). This spec does **not** implement graph-priority; rerank attaches to whatever order `assembleRetrievalResult` already produces.
> **Tracker:** local markdown; GitHub issues not assumed readable from remote.

## Objective

After retrieve has an ordered candidate list, optionally **reorder** those chunks with the same Anthropic LLM the extract CLI already uses, then cut Host `limit`. Failure or missing credentials must not block retrieve.

**Who:** MCP `retrieve` callers; operators who set `ANTHROPIC_AUTH_TOKEN` and
optional `GRAPHRAG_MEMORY_ANTHROPIC_MODEL` / `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL`
for extract.

## Glossary

From `docs/CONTEXT.md`: **retrieve**, **chunk**, **rerank**, **degraded=true**, **hybrid retrieval**. **主模型** here means the extract Anthropic adapter (`ANTHROPIC_AUTH_TOKEN`, default model `MiniMax-M3` on China `https://api.minimaxi.com/anthropic`), not the Host conversation model.

## Confirmed assumptions

1. This slice is a **temporary** LLM permutation, not the long-term cross-encoder HTTP client.
2. **Not** the Host chat model. **Not** a new model binary inside the MCP server.
3. ~~**Default off.** On = explicit rerank enable **and** token present; missing token → skip, not `degraded`.~~ **Superseded (C-3, `specs/retrieval-stack.md` §B3):** rerank is **default on**. Model / base URL default to `MiniMax-M3` / `https://api.minimaxi.com/anthropic` when unset. A missing token leaves a default-on capability unattempted → set `degraded=true` and name the rerank item in `degraded_reasons` (rule 1 of §B3), while still returning the pre-rerank order.
4. LLM throw / unparseable permutation → **fail-open**: keep pre-rerank order, set `degraded=true` and name the rerank item in `degraded_reasons`.
5. Envelope stays `{ chunks[] }` (+ optional `degraded`). No new Host keys.
6. Rerank runs **after** current Host ranking (today three-arm RRF; after graph-priority ships, that list). Window: permute a prefix **W** where `W = max(limit, candidateCap)`, bounded by available candidates, then cut `limit`.
7. Out of this spec: dedicated rerank HTTP service; self-trained models; graph tombstones/GC; changing graph-priority fusion.

## Boundaries

- **Does:** config gate; retrieve-path optional LLM reorder using extract Anthropic credentials; tests for unattempted (missing token) / fail-open / identity when off; CONTEXT `rerank` stage line.
- **Confirms with human:** ~~default-on~~ — **decided (C-3, `specs/retrieval-stack.md`)**: rerank is default on; sharing extract rate limits vs a separate key remains open.
- **Out of this spec:** cross-encoder sidecar; Host-model rerank; graph-priority implementation.

## Success Criteria

1. Rerank env off → Host order identical to today’s assembler (no LLM call). Unit test.
2. Rerank on, `ANTHROPIC_AUTH_TOKEN` absent → same order as off, **`degraded: true`**
   with the rerank item named in `degraded_reasons` (**Superseded C-3, `specs/retrieval-stack.md` §B3 rule 1** — was "no `degraded`"); model / base URL may be unset because they have defaults. Unit test.
3. Rerank on, fake LLM returns a valid permutation of ids → envelope `chunks[]` follows that permutation then `limit`. Unit test.
4. Rerank on, fake LLM throws or returns unknown ids → original order, `degraded: true`, no throw. Unit test.
5. MCP retrieve wire still `{ chunks[] }` (+ optional `degraded`). Existing envelope tests stay green.
6. `npm test` exits 0 without a live Anthropic network. `npm run build` exits 0 after impl.

## Open Questions

(none) for this temporary adapter. Dedicated rerank transport remains a later spec.

## Inherits / Changes

**Inherits:** CONTEXT **rerank** fail-open; extract Anthropic LLM credential
and defaults; `assembleRetrievalResult` as the only retrieve orchestrator;
ADR-0001 (no Neo4j writes).

**Changes:** production **may** call Anthropic on retrieve when enabled; CONTEXT `rerank` is no longer TBD-only.

## Testing Strategy (5 boundary classes)

| Class      | Coverage                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| empty      | Zero candidates → no LLM call, empty `chunks[]`                           |
| negative   | `limit` ≤ 0 → empty list, no LLM call (keep assembler behaviour)          |
| overflow   | Candidate list longer than W → only prefix W sent; output still ≤ `limit` |
| concurrent | Two retrieve calls with fake LLM do not share a mutable permutation       |
| exception  | LLM throw → fail-open + `degraded`; missing token → unattempted + `degraded` (C-3) |

## Architecture Change Reviewer

Planned files (≥3): `src/config.ts` (or retrieve config load), `src/core/retrieval/` orchestrator, LLM port (extract client or sibling), tests under `tests/retrieval/` / `tests/tools/`.

### Verdict (pre-plan gate · 2026-08-27)

bounded-context-guardian: yes — retrieval + existing extract LLM adapter; no Host coupling; no technical-layer dirs.
defensive-contract-validator: yes — Testing Strategy covers empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — skip (no creds) vs fail-open (throw) named; embed still hard-fail; EXIT on skip/fail-open.
complexity-anti-drift: yes — rerank is a helper after ranking, not inlined into a god `assembleRetrievalResult`.
minimal-change-verifier: yes — one logical task (temporary LLM rerank); not mixed with graph-priority impl or projection GC.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- CONTEXT **rerank** stage: temporary Anthropic extract-model adapter, default off, fail-open — flushed with the plan persist.
- **Flushed 2026-08-31 (C-3, `specs/retrieval-stack.md` §B3):** CONTEXT **rerank** now reads default on; missing token is an unattempted default-on capability → `degraded` + named in `degraded_reasons`; fail-open retained.

## Hand-off

- Spec: `specs/retrieve-rerank-llm.md`

