# Spec: P0 Eval — Extraction Quality Gate (LLM gold)

> **Status:** ACR all-yes (this file). Not implemented on main.
> **Source tickets:** [#15](https://github.com/winter6205/iknow-memory/issues/15) T-P0-eval; #5 P0e Q1/Q3/Q4 kept; **Q2 superseded** by operator 2026-08-30 (LLM replaces all human gold / audit).
> **Wayfinder parent:** [#1](https://github.com/winter6205/iknow-memory/issues/1).
> **Predecessors:** `specs/p0-schema.md`, `specs/p0-extraction.md`, `specs/p0-integration.md`; ADR-0001; retrieve eval is a **different** CLI (`specs/retrieve-p5.md`).
> **Assumption gate:** operator confirmed the LLM-gold upgrade path (2026-08-30). A1–A16 below are the gate.

## Objective

Make extraction quality **measurable, iterative, and regression-proof** for the LLM triple-extraction layer (spec 2), without a human annotator.

Concretely: an offline **eval CLI** scores **per-chunk raw triples** (before canonical merge, before retrieve) on three axes; **gold** is built by a **cross-family LLM** plus a **code filter**; **audit** of filter rejects is another LLM; **Bootstrap** records scores until steady state, then locks absolute thresholds; **PR** runs cheap drift; **Release** runs full three axes.

**Who:** operators and CI. Not MCP Hosts. No new tool.

**Success looks like:** `node dist/cli/eval.js` (or documented `npm run` alias) can gold-build, audit, bootstrap, and gate; `npm test` covers scoring/filter/gate without live gold-LLM; extraction F1 baseline exists as a file, not a slide.

## Glossary

Exact copy from `docs/CONTEXT.md` (SSOT) — not redefined here:

- **extraction F1** — LLM gold + eval filter (CONTEXT). Not **P@5 / R@5**.
- **extract_triples**, **triple**, **chunk**, **entity**, **extraction_records**, **MCP tool**, **host**, **iknow-memory**.

Terms used in this contract (eval filter / gold model / audit model are operational; CONTEXT keeps **extraction F1** as the product term):

- **evaluation object** — extraction-layer per-chunk **raw** triples (pre-merge).
- **three axes** — micro-F1 (primary); schema-compliance rate; hallucination rate. Error-type classification is diagnostic only (no threshold).
- **gold model** — LLM that proposes gold triples; model id **must not** equal the extractor model id.
- **audit model** — LLM that labels filter rejects; model id **must not** equal the extractor model id (may equal the gold model).
- **eval filter** — pure function: annotation guide in git (grounding / vocabulary / negation). Unique hard rule that is not an LLM.

## ASSUMPTIONS I'M MAKING

(operator 2026-08-30: 「人工部分我们直接全部由 LLM 替代」+「OK, 可以写」— treated as confirmed)

1. #5 Q1 stays: score **raw** pre-merge triples only. Merge-layer e2e gate stays out. Retrieve P@5 stays `eval:retrieve`.
2. #5 Q3 stays: absolute thresholds + drift; any axis fail fails the gate; error types never gate; Bootstrap records until adjacent F1 delta ≤ 0.05; threshold edits = commit + `Why:`.
3. #5 Q4 stays: PR = drift, no gold/extract LLM; Release = full three axes + **gold model** re-run of gold-build (new ruler if gold identity changes — must not silently reuse the old baseline curve).
4. **#5 Q2 is replaced:** no human anchor chunks, no human reject-pile auditor, no monthly human calendar. Filter is **not** calibrated by 10–15 human labels.
5. Gold volume = **gold model** over a **frozen chunk snapshot** in git, then **eval filter**. Snapshot v1 size **10–40** chunks inclusive (rule-sampled or fixture; not live crawl).
6. **Gold model id ≠ extract model id** (`--gold-build` ConfigError if equal). **Audit model id ≠ extract model id**. Sharing gold and audit models is allowed.
7. Changing the **extract** model must not rewrite gold. Changing gold model / gold prompt hash / snapshot id is a **new ruler**: new gold files + new Bootstrap, not a continuation of the previous F1 series without a `Why:` commit.
8. Match key for micro-F1: `relation_norm` via the same `normalizeRelation` path extract uses; **head/tail** = Unicode case-fold + trim only. **No** canonical merge on gold or predictions for this score.
9. Chunk snapshot is **frozen**. Appending chunks = new snapshot id + run-stamped gold. `--gold-build` **overwrites** the gold file for that snapshot+model+prompt-hash; it does not merge leftover triples from a previous gold model.
10. `baseline.json` default path `gold-set/baseline.json`; atomic write (temp + rename). Optional env override for the path is allowed; tests must not require a secret path.
11. Gold-build sampling: temperature **0** (or equivalent deterministic setting the client exposes). Seed is recorded in provenance when the API provides one.
12. `--audit-rejects` labels each reject as exactly one of: `agree-filter` | `filter-false-reject` | `gold-miss`. `gold-miss` may be merged into gold with provenance; `filter-false-reject` does **not** auto-edit `filter.ts` (opens an engineering follow-up, out of this CLI’s writes).
13. Prompt or ALLOWED vocabulary change → operator **must** re-run gold-build + audit before trusting gates (replaces “prompt change triggers human review”). Calendar review = scheduled re-run of the same commands (ops, not this spec’s CI).
14. Eval CLI is offline-only: never MCP, never imported by `src/tools/*`, `src/index.ts`, or `src/core/retrieval/*`. Mirror `src/cli/extract.ts` isolation. Do not import `eval-retrieve` scoring.
15. No schema/index/FK change. Eval **reads** existing extraction tables. No new runtime IR library. Secrets never in `gold-set/`.
16. Exit codes align with extract: **0** success (including Bootstrap record-only); **1** config/fatal; **2** usage error **or** gate tripped.

→ Correct in review or these are the spec.

## Boundaries

- **Does:**
  - Pure scoring of the three axes + five error types (diagnostic).
  - Code `filter` importing ALLOWED from extraction vocabulary (no copy).
  - Frozen chunk snapshot + `--gold-build` + `--audit-rejects` + `--bootstrap` + `--gate pr` + `--gate release`.
  - Baseline append, steady-state, threshold lock, atomic concurrent writes.
  - CI scripts that invoke PR/Release gates; Bootstrap-period PR script prints scores and does not fail on metric values.
  - Tests: unit + 5 boundary classes + subprocess CLI + optional loud-skip PG integration.

- **Confirms with human:** locking numeric thresholds after Bootstrap (operator commit + `Why:`); choosing live gold/audit model ids in env; growing snapshot past 40 chunks.

- **Out of this spec:**
  - Human annotation, human audit, human monthly review
  - Merge-layer e2e gate; retrieve P@5 (`specs/retrieve-p5.md`)
  - New MCP tools; extract/retrieve behaviour changes; Neo4j; schema migrations
  - Auto-rewriting `filter.ts` from audit output
  - Industry bake-off; fourth gated axis
  - Using the new extract model to regenerate gold

## Success Criteria

Binary; each maps to a command or measurable check.

1. `npm run typecheck` exits 0 after impl.
2. `npm test` exits 0; existing extract/retrieve/schema suites still pass (Neo4j-tagged tests may loud-skip).
3. `npm run build` emits the eval CLI next to `extract` / `eval-retrieve`; the eval entry imports neither `src/tools/*` nor `src/index.ts` (greppable isolation).
4. **Micro-F1 math:** gold 3 + pred 3 with 2 exact matches + 1 spurious → P=R=2/3, F1 = `2PR/(P+R)`. Unit test, hand-computed.
5. **Schema rate:** a pred with `UNMAPPED` `relation_norm` yields schema-compliance **< 1**. Unit test.
6. **Hallucination:** evidence span not a substring of chunk text counts as hallucinated. Unit test.
7. **Error types:** each mis-prediction gets exactly one of spurious / wrong-relation / wrong-entity / incomplete / schema-violation. No type in the gate. Unit test.
8. **Snapshot size:** in-repo chunk snapshot has 10–40 chunks inclusive; loader/CLI validate fails outside that range.
9. **Cross-family guard:** `--gold-build` and `--audit-rejects` exit **1** (ConfigError) when gold or audit model id equals extract model id.
10. **Filter as code:** accept path plus reject reasons no-grounding / relation-not-norm / entity-not-normalized / negated each have a unit test; filter imports ALLOWED from the vocabulary module (no hard-coded copy — grep).
11. **Provenance:** every gold triple in git has model id, prompt hash, chunk id, raw output, filter verdict. Loader typed-errors a triple missing provenance.
12. **Bootstrap:** `--bootstrap` appends three axes and does not apply absolute thresholds; `--gate release` before `thresholds` set exits **1** with a clear ConfigError.
13. **Steady state:** adjacent Bootstrap F1 delta ≤ 0.05 reports ready-to-lock; delta > 0.05 keeps Bootstrap. Unit test at the 0.05 boundary.
14. **PR gate:** no LLM call; `|ΔF1| ≤ 0.05` vs last baseline → exit 0; breach → exit 2; missing baseline → exit 0 (nothing to drift).
15. **Release gate:** three axes vs locked thresholds; any axis fail → exit 2; thresholds read from baseline file, not source literals.
16. **Atomic baseline:** two concurrent `--bootstrap` writers leave valid JSON containing both runs (or the documented last-writer-wins complete object — never truncated JSON).
17. **Five boundary classes** for filter / scoring / gate (see Testing Strategy).
18. **CI stubs:** documented `npm run gate:pr` / `gate:release` invoke the CLI; Bootstrap-period PR path prints numbers and does not fail on F1 magnitude.
19. **Gold overwrite:** second `--gold-build` for the same snapshot+model+prompt-hash does not keep triples that the new run did not emit (no silent merge of a previous gold model’s leftovers). Test with a fake LLM.
20. **Audit labels:** `--audit-rejects` with a fake auditor writes only the three allowed labels; unknown model-equal-extract is already SC9.

## Open Questions

(none) — A1–A16 pin the former T1 items (normalization, snapshot lifecycle, gold-build overwrite, baseline path/atomicity).

## Inherits / Changes

**Inherits:** spec-2 extract CLI isolation and 0/1/2 exits; `normalizeRelation` + ALLOWED vocabulary; spec-1 tables (`extraction_records`, triples, chunks) read-only; ADR-0001 (eval does not write Neo4j); #5 Q1/Q3/Q4; Vitest; TS strict ESM; Node ≥20; `ConfigError`; no iknow runtime import.

**Changes:** #5 Q2 human filter-first **replaced** by LLM gold + code filter + LLM audit (ADR-0002). New offline eval CLI, not mixed into `eval-retrieve`. CONTEXT **extraction F1** ground-truth sentence must change (persist).

## Testing Strategy (5 boundary classes)

| Class      | Coverage                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| empty      | empty gold; empty prediction; empty chunk text → typed outcome, no throw-as-1.0                                               |
| negative   | confidence outside [0,1] rejected; batch-size / threshold ≤ 0 → ConfigError; gold/audit model id equals extract → ConfigError |
| overflow   | huge gold (10k+ triples) and oversized chunk text finish without quadratic blow-up / stack overflow                           |
| concurrent | two `--bootstrap` writers → valid baseline JSON                                                                               |
| exception  | gate/scoring throw mid-run → process exit **1**, never a false gate-fail **2**                                                |

PG integration: score a persisted extract batch when Postgres is up; **loud skip** if unreachable (same Validation block as other `*-pg` tests).

## Architecture Change Reviewer

Planned files (≥3): eval scoring/filter/baseline/gate modules under the extraction-adjacent capability (not a `services/` layer, not Host tools); offline eval CLI beside `extract` / `eval-retrieve`; `gold-set/` fixtures; unit/defensive/CLI/PG tests; package scripts; runbook.

### Verdict (pre-plan gate · 2026-08-30)

bounded-context-guardian: yes — eval is an offline extraction-quality capability; no Host assembly; no technical-layer top-level dirs (`controllers`/`services`); isolation from `src/tools` and retrieve.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — ConfigError for model-id clash and pre-lock release gate; typed loader errors; EXIT on fatal is rerun/fix config; gate fail is exit 2 not swallowed; no empty catch in the contract.
complexity-anti-drift: yes — scoring, filter, baseline, gate, and CLI stay separate; CLI composes them, does not inline a god scorer.
minimal-change-verifier: yes — one logical task per tracer bullet in the plan; not mixed with retrieve P@5 or extract pipeline behaviour.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

(flushed 2026-08-30: CONTEXT **extraction F1** / **P@5 / R@5**; ADR-0002)

## Hand-off

- Spec: `specs/p0-eval.md`
- Plan: `plans/p0-eval.md`
- Parent ticket: [#15](https://github.com/winter6205/iknow-memory/issues/15)
