# Spec: Graph / rerank fail-start, process logs, evidence span persist

> **Status:** ACR PASS 2026-09-05 — see §Architecture Change Reviewer. Persist flushed. Plan: `plans/graph-rerank-boot-and-evidence.md`.
> **Assumption gate:** confirmed 2026-09-05 — grilling closed; decisions live here, not on a wayfinder map.
> **Slice:** first implementation slice. MCP tool catalog is `specs/mcp-tool-surface.md`.

## Objective

Make graph and rerank **default-on and honest at process start**, make extract/embed **observable without leaking secrets**, and make a triple's **evidence span** a persist gate plus a Postgres column.

**Who uses it:** operators starting the MCP server or `eval:retrieve`; extract/ingest pipelines; Hosts calling `retrieve` (envelope unchanged).

**Success looks like:** a process whose graph/rerank switches are on cannot boot without their deps; eval uses the same `loadEnv()` as the server; a triple that is not a substring of its chunk never lands; Host `chunks[]` still does not carry the span.

## Glossary

Exact copy from `docs/CONTEXT.md` (not redefined here):

- **iknow-memory**, **MCP tool**, **host**, **chunk**, **entity**, **triple**, **authoritative source**, **Neo4j sidecar**, **Neo4j graph arm**, **projection outbox**, **degraded=true**, **RetrieveConfig**, **rerank**, **retrieve**, **ingest**, **extract_triples**, **P@5 / R@5**, **extraction F1**, **mark-and-continue**

Terms this contract adds or tightens are on the 待写入 list (persist after ACR). Until flush, the spec uses:

- **evidence span** — the model-proposed substring of chunk text that grounds one **triple**. Not `source_ref`, not the whole chunk, not a Host citation field.

## Confirmed assumptions (gate · 2026-09-05)

1. One config object: `loadEnv()` / `GraphragEnv`. Production = Host MCP `env`. `.env.local` is test-only. No second config file.
2. Unset `graphEnabled` / `rerankEnabled` = **default on**. Explicit off is the only off.
3. Default-on graph or rerank with missing credentials or address → **refuse to start** (`ConfigError`), not start + `degraded`. This revises ADR-0005 rule 1 **for graph and rerank only**. Rule 2–4 stay. Vector / BM25 / Elasticsearch keep their current start + skip/`degraded` contracts.
4. `src/cli/eval-retrieve.ts` must not hardcode `graphEnabled: false` / `rerankEnabled: false`. Eval and server share `loadEnv()`.
5. Published retrieval ruler = **P@5 / R@5** on the default-on path (graph + rerank on unless env explicitly off). Keep the existing gold size (~12 queries). MRR / nDCG are not gates. No CI fail-on-metric-drop.
6. MCP `retrieve` default `limit` = 10. P@5 scores the first 5 of that Host list. Rerank permutes a window then cuts back to `limit`, not to 5.
7. P@5 / R@5 are **dev eval only**, not production SLOs. Production this slice only refuses start when graph/rerank deps are missing. Latency and concurrency are out. Orphan/duplicate entities are a later step.
8. Changing extract/merge quality (F1 gold, baseline, thresholds) is **not** this slice. The evidence-span **substring gate** is this slice; locking F1 numbers is not.
9. Structured logs for **extract** and **embed**: time, chunk id, model id, latency, success/fail, counts. Field whitelist. Do not log secrets. Existing `redactDiagnostic` covers Postgres/Neo4j URLs in errors; it is not an ingest-body secret scanner. Do not silently mask stored chunk text.
10. Evidence span **对不对** = persist gate (`chunkText.includes(evidenceSpan)` and non-empty). **准不准** = later F1 vs gold, after a legal triple exists. Eval already has `isGrounded` in `src/core/extraction-eval/filter.ts`. Production extract must apply that grounding check. Persist on `triples` (column `evidence_span`) in the same write as the edge. Retrieve does not put the column on Host `chunks[]`.
11. Other `filterTriple` reasons (`relation-not-norm`, `entity-not-normalized`, `negated`) stay eval-only unless a later spec promotes them.
12. On triple merge (existing first-row survivor): do not overwrite the survivor's `evidence_span` (same provenance rule as `source_chunk_id`).
13. Runtime: URI/token present but Neo4j or reranker **call** fails → still fail-open + `degraded` (ADR-0005 rule 2). Fail-start is missing config at boot, not a dead sidecar at retrieve time.
14. `npm test` stays green without live Neo4j (tests inject config; they do not boot `loadEnv()` as the server does).
15. Node-embedding and wait-for-drain default-on / fail-start are **not** decided here.

## Objective detail — fail-start deps

When the switch is on (default or explicit true):

- Graph requires a usable Neo4j config (`GRAPHRAG_MEMORY_NEO4J_URI` family as `parseNeo4jConfig` already validates when a URI is present). Missing URI while graph is on → `ConfigError`.
- Rerank requires the credentials/address the **production retrieve path** actually uses (today: HTTP `rerankUrl` and/or the wired LLM rerank secret, whichever `buildDeps` / retrieve wiring consults). Missing that while rerank is on → `ConfigError`.

When the switch is explicit false, missing those deps is legal; do not set `degraded` for the off switch (ADR-0005 rule 4).

## Boundaries

- **Does:**
  1. Fail-start for default-on graph and rerank; same `loadEnv()` for server and `eval:retrieve`.
  2. Structured extract + embed logs with a field whitelist and no secrets.
  3. Production extract grounding gate + `triples.evidence_span` column; retrieve envelope unchanged.
- **Confirms with human:** promoting other `filterTriple` reasons to persist gates; fail-start for node-embedding / wait-for-drain; changing default `limit` or gold size.
- **Out of this spec:** MCP tool catalog (`specs/mcp-tool-surface.md`); session memory; chunks in Neo4j; Neo4j as SoR; extraction F1 lock; latency/concurrency SLOs; orphan entities; answer quality / LLM-as-judge; Host citation UI; second config file; `.reference` at runtime.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Graph fail-start:** `graphEnabled` true (default) and no Neo4j URI → `loadEnv()` throws `ConfigError`; process does not open MCP stdio. Unit test on config load.
2. **Rerank fail-start:** `rerankEnabled` true (default) and production rerank deps missing → `loadEnv()` throws `ConfigError`. Unit test.
3. **Explicit off:** `graphEnabled=false` with no Neo4j URI → `loadEnv()` succeeds. Same for rerank off without rerank deps. Unit test.
4. **Eval shares config:** `eval:retrieve` assembler config comes from `loadEnv()` retrieval flags; source does not assign `graphEnabled: false` / `rerankEnabled: false`. Grep of that CLI plus a unit test that a default-on env keeps both true.
5. **Ruler path:** documented eval publish path is P@5 / R@5 on default-on graph+rerank unless env explicitly off. Gold query count stays the existing set. No new MRR/nDCG gate file. `npm run eval:retrieve --help` / harness still writes the existing baseline shape.
6. **Runtime still fail-open:** configured Neo4j/rerank that throws at retrieve time still returns chunks + `degraded: true` (existing fail-open tests remain).
7. **Grounding gate:** production extract, given a triple whose `evidenceSpan` is missing, empty, or not a substring of the chunk, does not insert that triple; batch continues (`mark-and-continue`). Unit test with a fake LLM output.
8. **Column:** after a grounded insert, Postgres `triples.evidence_span` equals the accepted span. Schema init / `ADD COLUMN IF NOT EXISTS` on existing DBs. Unit or integration test against the storage helper.
9. **Envelope:** successful `retrieve` JSON still has `chunks` plus optional `degraded` / `degraded_reasons`; no `evidence_span` (or equivalent) on Host chunk objects. Existing envelope tests plus a negative assertion.
10. **Logs:** one extract chunk and one embed call emit structured fields `{ time | chunk id | model id | latency | success/fail | counts }` and do **not** contain API keys or raw chunk text. Unit test on the log payload (fake clock / fake logger).
11. **`npm test` and `npm run build` exit 0** without live Neo4j.

## Open Questions

(none) — catalog and session memory live in `specs/mcp-tool-surface.md`.

## Inherits / Changes

**Inherits:**

- ADR-0001: Postgres SoR; Neo4j read-only projection; chunks never enter the graph.
- ADR-0003: retrieval indexes are derived.
- ADR-0004: no re-chunking.
- ADR-0005 rules 2–4; field names `degraded` / `degraded_reasons`.
- `specs/retrieve-graph-priority.md` Host ranking; `specs/retrieve-p5.md` gold harness shape (query → chunk ids, P@5 / R@5).
- Stack: TypeScript strict ESM, Node ≥20, Vitest, `npm test` / `npm run build`.
- `isGrounded` / `chunkText.includes(evidenceSpan)` in `src/core/extraction-eval/filter.ts`.
- LLM already emits `evidenceSpan` (`ExtractionOutput`).
- `ConfigError` + `loadEnv()` as the only env parser.
- MCP tools currently registered: `echo`, `ingest`, `push`, `invalidation`, `retrieve` (catalog change is the other spec).

**Changes:**

- ADR-0005 rule 1 does **not** apply to graph or rerank: missing deps → do not start. Other default-on capabilities unchanged.
- CONTEXT **Neo4j sidecar** “optional by construction / server starts with no sidecar” is false for default-on graph.
- CONTEXT **degraded=true**, **Neo4j graph arm**, **rerank**, **RetrieveConfig**, **hybrid retrieval**, **retrieve**, **P@5 / R@5** must stop saying missing graph/rerank URI-or-token is an unattempted `degraded` retrieve.
- Eval must not publish a “clean two-arm” run by hardcoding graph/rerank off.
- `triples` gains `evidence_span`; production extract calls the grounding check before persist.
- **triple** glossary must mention the span column.

## Tech Stack

Unchanged. No new runtime dependency. Schema column only.

## Commands

```bash
npm test
npm run build
npm run eval:retrieve
```

## Testing Strategy (5 boundary classes)

| Class      | Coverage in this spec                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| empty      | Empty `evidenceSpan` / empty chunk text → no persist; missing Neo4j URI with graph on → `ConfigError`     |
| negative   | Explicit `graphEnabled=false` / `rerankEnabled=false` with missing deps → start allowed                   |
| overflow   | Over-long span that is still a substring persists; span longer than chunk and not a substring is rejected |
| concurrent | Two extract chunks in one batch: one ungrounded does not block the grounded sibling (`mark-and-continue`) |
| exception  | `loadEnv()` missing deps → typed `ConfigError`; retrieve-time Neo4j/rerank throw → fail-open + `degraded` |

## Architecture Change Reviewer

Planned blast radius (implementation; ≥3 files):

- `src/config.ts` — fail-start when graph/rerank on and deps missing
- `src/cli/eval-retrieve.ts` — drop hardcoded off; use `loadEnv()` retrieval flags
- `src/core/extraction` persist path (`extract` CLI / `dedup` upsert) — grounding gate + column
- `src/core/storage/schema-p0.ts` — `evidence_span` on `triples`
- extract + embed log emission (existing `createLogger` surface)
- tests under `tests/` for config, extract persist, retrieve envelope, log fields
- `docs/CONTEXT.md` / `docs/adr/` — persist this SPECIFY turn (not an impl file)

### Verdict (pre-plan gate · 2026-09-05)

bounded-context-guardian: yes — config + extraction + retrieval stay in existing capability slices; no controllers/services/repositories tree; no Host package; schema stays on `triples` in Postgres.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception; SC1–SC10 bind observables.
error-handling-enforcer: yes — boot uses typed `ConfigError`; retrieve-time failure stays fail-open + `degraded`; ungrounded triple is reject + mark-and-continue, not empty catch or null row.
complexity-anti-drift: yes — declared split: config fail-start helper, reuse `isGrounded` rather than a second substring algorithm, log emitter as a small field whitelist, upsert column plumbing — not one god `loadEnv`/`extract` rewrite.
minimal-change-verifier: yes — one logical slice (honest default-on + evidence persist + process logs); MCP catalog, F1 lock, session memory, and Host citations are out; plan will commit per tracer bullet.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- ~~CONTEXT terms listed above + **evidence span**~~ flushed 2026-09-05.
- ~~ADR-0006 fail-start; ADR-0005 rule 1 body notes the graph/rerank exception~~ flushed 2026-09-05 (guard does not accept combined Status; 0005 stays `accepted` with an exception sentence).

## Hand-off

- Spec path: `specs/graph-rerank-boot-and-evidence.md`
- Companion spec: `specs/mcp-tool-surface.md` (not this plan)
- Plan path: `plans/graph-rerank-boot-and-evidence.md`
