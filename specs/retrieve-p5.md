# Spec: Retrieve P@5 Baseline Harness

> **Superseded in part (eval boot):** the published ruler is default-on graph+rerank via `loadEnv()` (`specs/graph-rerank-boot-and-evidence.md`). Do not hardcode graph/rerank off to publish a two-arm run.

> **Status:** ACR-passed (architecture-change-reviewer 5-verdict gate — see §Architecture Change Reviewer).
> **Predecessor:** `specs/neo4j-graph-arm.md` / `specs/bm25-retrieve.md` (production retrieve = vector + BM25 + optional Neo4j PPR).
> **Assumption gate:** confirmed 2026-08-27 (A1–A13 below). Operator: 「没问题」.

## Objective

Give the map Completion gate a **repeatable retrieve quality number**: **P@5** (and recorded **R@5**) over the Host-visible **fused `chunks[]`**, without opening extraction F1 and without changing production retrieve.

**Who uses it:** operators / implementers running an eval CLI against a frozen gold set; not MCP Hosts (no new tool).

**Success looks like:**

- `npm run eval:retrieve` (or equivalent documented script) scores gold queries against the same fusion path `retrieve` uses, writes a git-tracked baseline JSON, exits 0 on a clean 2-arm skip (no Neo4j URI).
- One P@5 per query and a run-level mean; denominator of P@5 is **always 5** (fewer than 5 returned chunks → remaining slots are misses).
- `npm test` green; no CI fail-on-drift in this spec.

## Glossary

Exact copy / stage notes from `docs/CONTEXT.md` (SSOT) — not redefined here:

- **P@5 / R@5** — precision and recall at rank 5 over the Host-visible fused `chunks[]` (vector + BM25, plus Neo4j PPR when a URI is configured); gold is query → relevant chunk ids, Bootstrap records numbers only (no CI gate), and a missing Neo4j URI is skip not a failed run. A retrieve-eval arm separate from **extraction F1** (stays postponed). (_Stage: morphology locked; this spec implements._)
- **extraction F1** — fact-level precision and recall for triple extraction. Out of this spec.
- **hybrid retrieval** / **RRF fusion (k=60)** / **retrieve** / **degraded=true** / **RetrieveConfig** / **Neo4j graph arm** / **vector search** / **BM25** — as in CONTEXT.
- **chunk** / **valid_window** / **valid_at** — as in CONTEXT.

## Confirmed assumptions (gate · 2026-08-27)

1. **one** fused ranking, **one** P@5 — not three arm exams plus a merge exam.
2. Gold = query → set of relevant **chunk ids**. P@5 = (hits in fused top-5) / **5**; if retrieve returns n<5, the missing 5−n slots are misses.
3. R@5 is computed and stored (hits in top-5 / |gold relevant ids| for that query; empty gold relevant set is a fixture error, not silent 1.0). Bootstrap does **not** fail the process on metric values.
4. Scoring consumes the production fusion path (`assembleRetrievalResult` / equivalent used by MCP `retrieve`), not a second retriever.
5. No Neo4j URI → vector+BM25 fusion; eval **succeeds**. The Bootstrap harness CLI (`npm run eval:retrieve` / `runCliFromEnv`) is **two-arm-only today**: it constructs no graph ranker whatever `NEO4J_URI` is set to, so every CLI run records `armSet` `vector+bm25`. Three-arm fusion (`vector+bm25+graph`) is reachable only by calling `runCli` with an injected `graphRanker` dep; wiring an optional Neo4j graph-ranker path into `runCliFromEnv` is deferred to follow-up **RETRIEVE-FU-3**. With a graph ranker injected it is still one fused ranking and one P@5. Production keeps its fail-open `degraded` rules, but the harness refuses to publish a degraded run: any envelope carrying `degraded: true` — a configured arm was attempted and could not deliver — is rejected by `assertArmsDelivered`, so the run exits non-zero and writes **no** scores and no baseline. `armSet` reads arm participation, so a baseline naming an arm that never contributed would record a fallback ranking under a label it did not earn, and the P@5 gap would read as a retrieval regression instead of the outage it is. Skip-without-URI is **not** degraded: the graph arm is simply absent from `armSet`, the run succeeds and scores are written as normal (SC5).
6. No change to default weights 0.7 / 0.15 / 0.15, RRF k=60, or rerank.
7. New CLI / eval surface only; **no** new MCP tool; **not** merged into the extraction harness.
8. Gold v1 = **8–15** queries over a **repeatable in-repo seed** (fixture corpus), no web crawl, no LLM gold expansion.
9. Baseline JSON is git-tracked: per query fused top-5 ids, P@5, R@5, arm-set (`vector+bm25` vs `vector+bm25+graph`). Consecutive runs may be diffed by humans; this spec does **not** wire CI failure on drift.
10. Stack: TS strict ESM · Node ≥20 · Vitest · `npm test`. No new IR-framework runtime dependency.
11. This PR/docs slice lands `specs/retrieve-p5.md`.
12. Implementation branch is **not** mixed into T-007.
13. Out of spec: per-arm diagnostic reports; PR/Release absolute thresholds; industry bake-off; chunker changes; `merged_into`; P1 rerank / node embedding.

## Boundaries

- **Does:**
  - Pure P@5 / R@5 scoring with fixed denominator 5.
  - Frozen gold fixture (8–15 queries, chunk ids).
  - Eval CLI that runs production fusion, writes baseline JSON, `npm run eval:retrieve`.
  - Tests: empty gold / bad gold / overflow top-k / retrieve throw / concurrent two runs as specified in Testing Strategy.
  - CONTEXT stage line for P@5 from “morphology locked” to implemented-on-branch when T-last lands.
- **Confirms with human:** adding CI drift gate after Bootstrap (Ask-first); growing gold beyond 15; publishing per-arm diagnostics.
- **Out of this spec:** extraction F1 harness; changing retrieve defaults; new MCP tools; LangGraph; dual-write Neo4j; Host protocol tests (T-007 already closed).

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Fixed-denominator P@5:** Given fused ids `[a,b]` and gold `{a}`, P@5 = 1/5. Unit test, no I/O.
2. **R@5:** Same fixture, |gold|=2 `{a,c}`, top-5 contains only `a` → R@5 = 1/2. Empty gold relevant set → typed error, not a score of 1.
3. **Gold size:** In-repo gold file has between 8 and 15 queries inclusive; `npm test` (or eval CLI validate) fails if outside that range.
4. **Same fusion path:** Eval runner calls the same assembler MCP `retrieve` uses (import of `assembleRetrievalResult` or the retrieve handler with injected deps — implementer headroom). A unit/integration test spies or types that the eval module does not reimplement RRF.
5. **No-URI run succeeds:** With Neo4j URI unset, `eval:retrieve` exit 0; baseline `armSet` is two-arm (not graph); process is not failed “because graph skipped”.
6. **Baseline written:** After a successful run, a JSON file in-repo (path implementer-chosen under `eval/` or `tests/fixtures/`) contains per-query `top5`, `pAt5`, `rAt5`, `armSet`. Second run is byte-stable given FakeEmbedder + MemoryBackend + frozen gold (or documented float tolerance of 0).
7. **No MCP tool:** `tools/list` still echo+ingest+retrieve only (existing host-smoke / index tests stay green).
8. **No new IR npm dependency:** `package.json` dependencies do not gain ir-datasets / ranx / pytrec_eval / equivalent solely for this feature.
9. **Five boundary classes** covered in tests (see Testing Strategy).
10. **Full suite:** `npm test` exits 0 on the implementation branch after all plan bullets (Neo4j-tagged files may loud-skip).
11. **Isolation:** Eval CLI does not import iknow runtime; does not write Neo4j.

## Open Questions

(none) — assumption gate A1–A13 confirmed. Residual headroom: exact JSON schema field names, CLI flag spelling, whether eval lives under `src/cli` vs `src/core/eval` (capability name **evaluation**, not a `services/` layer).

## Inherits / Changes

**Inherits:**

- Stack: TypeScript strict ESM, Node ≥20, Vitest, `npm test` / `npm run build`.
- Retrieve: `assembleRetrievalResult`, RRF k=60, defaults 0.7/0.15/0.15, skip-without-URI / fail-open-when-configured from `specs/neo4j-graph-arm.md` and `specs/bm25-retrieve.md`.
- ADR-0001: eval may read Postgres ledger + optional Neo4j ranker the same way retrieve does; eval does not become a second SoR.
- Resolution: fused `chunks[]` only; Bootstrap no CI gate.
- Hard contracts: env names not hardcoded secrets; no iknow `src/` import.

**Changes:**

- New **evaluation** capability (CLI + scorer + gold + baseline file). Production retrieve behaviour unchanged.
- CONTEXT **P@5 / R@5** stage: locked → implemented when T-last completes (待写入).

## Testing Strategy

| Class      | Cases                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| empty      | Empty gold file / empty query string → typed error, exit ≠ 0, no baseline overwrite                          |
| negative   | Gold relevant set empty for a query; P@5 denominator still 5; duplicate chunk ids in top-5 counted once      |
| overflow   | Gold with >15 queries rejected; retrieve `limit` used for scoring is 5 even if caller asks 100               |
| concurrent | Two overlapping eval runs: no torn baseline (atomic write or exclusive lock — implementer picks one, tested) |
| exception  | Injected assembler throw → typed error, non-empty message, `// EXIT:` on the CLI fallback, no silent `[]`    |

## Architecture Change Reviewer

Planned blast radius (implementation; ≥3 files):

- `src/cli` eval entry + `package.json` script `eval:retrieve`
- `src/core/eval` (or sibling **evaluation** capability slice) — P@5/R@5 + gold load
- gold + baseline JSON under repo (not `controllers/` / `services/`)
- tests for scorer + CLI
- `docs/CONTEXT.md` stage refresh on last bullet

### Verdict (pre-plan gate · 2026-08-27)

bounded-context-guardian: yes — new work is an **evaluation** capability (CLI + scorer), not a technical-layer package; retrieve/storage stay owners of fusion and SoR; no `controllers/` / `services/` / `repositories/` dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception; SC1–SC3, SC9 bind them.
error-handling-enforcer: yes — empty/invalid gold and assembler throw are typed errors with non-empty messages; skip-without-URI is success not catch-swallow; baseline write failure must not leave a truncated file (EXIT documented on that fallback).
complexity-anti-drift: yes — declared split: pure score, gold I/O, CLI runner, docs; no god-file “eval everything including retrieve rewrite”.
minimal-change-verifier: yes — one logical outcome (retrieve P@5 Bootstrap harness); no new IR runtime dep (SC8); per-bullet 1-commit sequencing owned by `writing-plans`.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- CONTEXT **P@5 / R@5** already flushed to morphology-locked text. Last impl bullet re-touches `_Stage:` to implemented.
- No new ADR (eval harness is reversible; not a SoR / protocol one-way door).

## Hand-off

- Spec path: `specs/retrieve-p5.md`

