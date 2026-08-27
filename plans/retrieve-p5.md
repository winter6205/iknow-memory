# Plan: Retrieve P@5 Baseline Harness

**Goal:** Operators can run a fused retrieve eval that writes git-tracked P@5 / R@5
baseline JSON without changing production retrieve or opening extraction F1 (#15).
**Approach:** Land a pure scorer + frozen gold first so denominator-5 P@5 and R@5
are testable without I/O. Then wire the production fusion path into a CLI that
writes baseline JSON and treats missing Neo4j URI as a successful 2-arm run.
Close with suite + CONTEXT stage. Coarse bullets on purpose — JSON field names,
CLI flags, and whether eval lives under `cli` vs an **evaluation** capability
slice stay implementer headroom. Out of scope stays map-level: #15, per-arm
diagnostics, PR/Release thresholds, industry bake-off, chunker, `merged_into`,
P1 rerank / node embedding.
**Spec link:** `specs/retrieve-p5.md` (binding; SC = Success Criteria; A# = assumptions)
**ACR:** all-yes (2026-08-27; block pasted below)
**Per-ticket loop (all bullets):** tdd → typecheck+tests →
verification-before-completion → one commit on the ticket branch
(end-of-round code-review once before merge)
**Tracker:** GitHub main path — parent [#82](https://github.com/winter6205/iknow-memory/issues/82).
Child `ready-for-agent` issues listed under Tasks. Repo has no `spec` label;
spec artifact is `specs/retrieve-p5.md` plus a comment on #82 (not a invented label).

## architecture-change-reviewer verdict

Pasted from `specs/retrieve-p5.md` §Architecture Change Reviewer
(gate run 2026-08-27):

bounded-context-guardian: yes — new work is an **evaluation** capability (CLI + scorer), not a technical-layer package; retrieve/storage stay owners of fusion and SoR; no `controllers/` / `services/` / `repositories/` dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception; SC1–SC3, SC9 bind them.
error-handling-enforcer: yes — empty/invalid gold and assembler throw are typed errors with non-empty messages; skip-without-URI is success not catch-swallow; baseline write failure must not leave a truncated file (EXIT documented on that fallback).
complexity-anti-drift: yes — declared split: pure score, gold I/O, CLI runner, docs; no god-file “eval everything including retrieve rewrite”.
minimal-change-verifier: yes — one logical outcome (#80/#82 retrieve P@5 Bootstrap harness); no new IR runtime dep (SC8); per-bullet 1-commit sequencing owned by `writing-plans`.

OVERALL: PASS — proceed with tracer bullets.

## 待写入

- CONTEXT **P@5 / R@5**: morphology already flushed to this docs branch (#80 wording). T3 re-touches `_Stage:` from `morphology locked (#80); not implemented` to implemented-on-branch.
- No ADR open/reopen (eval harness is reversible; SoR stays ADR-0001).

## Tasks (ordered by dependency)

1. **Gold fixture schema + pure P@5 / R@5 scorer** — tag: `[implementation]`
   - **Inherits:** Spec SC1–SC3, SC9 (empty / negative / overflow of those); A2–A3; denominator of P@5 is always 5; empty gold relevant set is a typed error not a score of 1.0; gold v1 size 8–15 queries inclusive.
   - **Surface:** evaluation capability (scorer + gold load) plus unit tests; no retrieve I/O in this bullet.
   - **Acceptance:** SC1–SC3 hold in tests with no network; empty gold file / empty relevant set / gold size outside 8–15 fail typed; P@5 uses fixed denominator 5 when fused list is shorter than 5.
   - Status: [ ] pending
   - Tracker: https://github.com/winter6205/iknow-memory/issues/83

2. **Eval CLI on production fusion + baseline JSON + no-URI skip** — tag: `[implementation]`
   - **Inherits:** Spec SC4–SC8, SC11; A4–A7, A9–A10; same assembler MCP `retrieve` uses; skip-without-URI is success (`armSet` two-arm); no new MCP tool; no new IR runtime dependency; concurrent two runs must not tear the baseline file.
   - **Surface:** existing `cli` + retrieve assembler (`assembleRetrievalResult` / retrieve handler with injected deps — implementer headroom); `package.json` script `eval:retrieve`.
   - **Acceptance:** `npm run eval:retrieve` exit 0 with Neo4j URI unset; baseline JSON has per-query top-5 ids, P@5, R@5, armSet; second frozen-fixture run is byte-stable; `tools/list` still echo+ingest+retrieve; assembler throw is typed with non-empty message and no silent `[]`.
   - Status: [ ] pending
   - [blocks: T1]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/84

3. **Suite closure + CONTEXT stage refresh** — tag: `[implementation]`
   - **Inherits:** Spec SC9–SC11; persist list above; A11–A13 (this round is spec/plan first; this bullet is last impl).
   - **Surface:** full `npm test` / `npm run build`; `docs/CONTEXT.md` **P@5 / R@5** stage line.
   - **Acceptance:** SC9–SC11; five boundary classes covered; CONTEXT `_Stage:` no longer says `not implemented`; eval CLI does not import iknow runtime.
   - Status: [ ] pending
   - [blocks: T2]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/85

## Code review phase (end of round)

After T1–T3 land on the implementation branch: one `arthurpower:code-review` pass on the full diff, then merge. Not per bullet.
