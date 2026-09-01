# Plan: P0 Eval — Extraction Quality Gate (LLM gold)

**Goal:** Offline eval CLI scores pre-merge extract triples on three axes against LLM-built gold, with Bootstrap then PR-drift / Release-absolute gates — no human annotator.
**Approach:** Pin types and a provenance-strict gold loader first; land pure scoring, filter, baseline, and gate as separate slices; wire one CLI; then PG read-path and git snapshot / CI / runbook. Do not mix retrieve P@5 or extract pipeline changes into these commits. Model ids, prompt text, and exact JSON field names stay implementer headroom inside the spec’s invariants.
**Spec link:** `specs/p0-eval.md`
**Tracker:** GitHub — parent [#15](https://github.com/winter6205/iknow-memory/issues/15); reuse child issues [#40](https://github.com/winter6205/iknow-memory/issues/40)–[#48](https://github.com/winter6205/iknow-memory/issues/48) (bodies rewritten to this plan). Do not open a second set of T1–T9 issues.
**ACR:** all-yes (copied from spec)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — eval is an offline extraction-quality capability; no Host assembly; no technical-layer top-level dirs (`controllers`/`services`); isolation from `src/tools` and retrieve.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — ConfigError for model-id clash and pre-lock release gate; typed loader errors; EXIT on fatal is rerun/fix config; gate fail is exit 2 not swallowed; no empty catch in the contract.
complexity-anti-drift: yes — scoring, filter, baseline, gate, and CLI stay separate; CLI composes them, does not inline a god scorer.
minimal-change-verifier: yes — one logical task per tracer bullet below; not mixed with retrieve P@5 or extract pipeline behaviour.

## Tasks (ordered by dependency)

ADR-0002 and CONTEXT **extraction F1** are already flushed (not a tracer bullet).

1. **Gold types + snapshot/gold loader** — tag: `[implementation]`
   - **Inherits:** spec A8, A9, SC8, SC11: match key is case-fold+trim heads/tails + extract `normalizeRelation` for `relation_norm`; snapshot 10–40 chunks; every gold triple has provenance; missing provenance is a typed error; no merge into gold from a previous gold model on overwrite (overwrite behaviour is asserted with the CLI in T6 — loader still rejects malformed files).
   - **Surface:** extraction-adjacent eval capability (same family as `src/core/extraction`, not retrieve, not MCP tools).
   - **Acceptance:** a valid fixture snapshot+gold loads; a gold triple without provenance is a typed error; snapshot size outside 10–40 fails validation; `npm test` path for this loader does not call a live LLM.
   - Status: [x] done — `src/core/extraction-eval/{types,errors,fixture-io,snapshot,gold,match-key}.ts`; tests `tests/extraction-eval/{snapshot,gold,match-key}.test.ts` (50 cases, no live LLM)
   - [blocks: none]

2. **[parallel] Three-axis scoring** — tag: `[implementation]`
   - **Inherits:** spec SC4–SC7, A1: micro-F1 exact match on the pinned key; schema rate vs ALLOWED; hallucination = evidence span not a substring; five error types diagnostic only.
   - **Surface:** same eval capability as T1.
   - **Acceptance:** the SC4 hand-computed F1 case passes; UNMAPPED lowers schema rate; non-substring evidence counts as hallucinated; each mis-prediction gets exactly one error type.
   - Status: [ ] pending
   - [parallel]
   - [blocks: T1]

3. **[parallel] Eval filter** — tag: `[implementation]`
   - **Inherits:** spec A4, SC10: code filter; ALLOWED imported from extraction vocabulary; reject reasons no-grounding / relation-not-norm / entity-not-normalized / negated.
   - **Surface:** same eval capability; vocabulary module already on main.
   - **Acceptance:** accept path plus each reject reason has a test; grep shows no hard-coded ALLOWED copy inside the filter module.
   - Status: [ ] pending
   - [parallel]
   - [blocks: T1]

4. **Baseline append, steady state, atomic write** — tag: `[implementation]`
   - **Inherits:** spec A2, A10, SC12, SC13, SC16: Bootstrap records only; adjacent F1 delta ≤ 0.05 is ready-to-lock; concurrent writers do not leave truncated JSON.
   - **Surface:** eval capability + `gold-set/` (or env override path).
   - **Acceptance:** append records three axes; 0.05 boundary is tested both ways; two concurrent appends leave valid JSON; release-gate refuse-until-lock can live here or in T5 but must exist before T6.
   - Status: [ ] pending
   - [blocks: T2]

5. **PR drift gate + Release absolute gate** — tag: `[implementation]`
   - **Inherits:** spec A3, SC14, SC15: PR is LLM-free; missing baseline passes; |ΔF1| > 0.05 → fail; Release reads thresholds from baseline, any axis fail fails; error types never gate.
   - **Surface:** eval capability (pure functions; CLI wires flags in T6).
   - **Acceptance:** drift pass/fail at ±0.05; first run with no baseline passes; absolute pass/fail per axis; thresholds not hard-coded in the gate module.
   - Status: [ ] pending
   - [blocks: T4]

6. **Eval CLI** — tag: `[implementation]`
   - **Inherits:** spec A6, A11, A12, A14, A16, SC3, SC9, SC19, SC20: flags gold-build / audit-rejects / bootstrap / gate pr / gate release; gold and audit model ids ≠ extract; gold-build overwrites same snapshot+model+prompt-hash; audit labels are the three allowed values; isolation from tools/index/retrieve; exits 0/1/2 as spec.
   - **Surface:** existing CLI family (`extract`, `eval-retrieve`) — new eval entry, not an MCP tool.
   - **Acceptance:** subprocess tests cover unknown flag → 2, model-id clash → 1, `--gate pr` with no baseline → 0, `--gate release` before lock → 1; fake LLM gold-build overwrite drops leftover triples; eval entry does not import `src/tools` or `src/index`.
   - Status: [ ] pending
   - [blocks: T3, T5]

7. **[parallel] Postgres eval integration** — tag: `[implementation]`
   - **Inherits:** spec A15: read existing extraction tables only; loud skip if Postgres unreachable.
   - **Surface:** existing spec-2 PG test isolation / `extraction_records` + triples.
   - **Acceptance:** with Postgres up, a persisted extract batch can be scored; with Postgres down, the suite skips loudly (documented Validation), not a silent pass.
   - Status: [ ] pending
   - [parallel]
   - [blocks: T6]

8. **[parallel] Frozen snapshot v1 + CI scripts + runbook** — tag: `[implementation]`
   - **Inherits:** spec A5, A13, SC8, SC18: 10–40 chunk snapshot in git; `gate:pr` / `gate:release` scripts; Bootstrap-period PR path prints numbers and does not fail on F1 magnitude; runbook: gold-build → audit → bootstrap → lock thresholds → observe gates. Live LLM gold-build is documented, not required for `npm test`.
   - **Surface:** `gold-set/`, `package.json` scripts, operator runbook docs.
   - **Acceptance:** snapshot size in range; `npm run gate:pr` and `gate:release` invoke the eval CLI; runbook names the command sequence and the “new ruler” rule (extract model must not rewrite gold); `npm test` still green without gold-model credentials.
   - Status: [ ] pending
   - [parallel]
   - [blocks: T6]

## 待写入 (persist)

(none — CONTEXT **extraction F1** / ADR-0002 flushed with the spec)

## End of round

After T1–T8 land: code-review (Standards + Spec) vs `specs/p0-eval.md`, then verification-before-completion. Do not mix `eval-retrieve` or extract pipeline behaviour into these commits. Claim a bullet by flipping **Status** in this file.
