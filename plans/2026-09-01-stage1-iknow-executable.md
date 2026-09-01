# Plan: Stage 1 iknow — quality T2–T5 + p0-eval

**Goal:** 在本 worktree 上并行落地质量栈可执行子集（dedicated HTTP rerank + projection GC + self-loop reject + `merged_into`）与 p0-eval 全链路（gold loader → scoring/filter → baseline/gate → CLI → PG/CI），本轮不接 fin 推送、不改跨仓对齐基线。
**Approach:** 双轨同一文件：Track Q 不依赖外部 rerank URL，默认第一刀为 Q-T3 / Q-T4 / Q-T5 三路并行；Q-T2 与之 `[parallel]` 但不是本轮默认产品第一刀，且 `npm test` 禁止 live HTTP。Track E 的「真实数据」路径就是 p0-eval frozen 10–40 chunk snapshot + gold-build；默认第一刀为 E-T1（gold loader），其后按 `plans/p0-eval.md` 依赖图推进 T2–T8。两轨互不阻塞；eval 子弹不掺 extract 管线行为，也不掺 retrieve P@5。
**Spec link:** `specs/retrieve-graph-quality.md` · `specs/p0-eval.md`（源计划：`plans/retrieve-graph-quality.md` · `plans/p0-eval.md`）
**Tracker:** **local markdown fallback** — 本文件为执行 SSOT。Operator 禁止 GitHub issues；**不要** `gh issue create`。`plans/retrieve-graph-quality.md` 已写明 GitHub 不是 tracker。认领方式：在本文件翻转对应子弹 **Status**。
**ACR:** all-yes（分轨各贴 5 行，仍全部 yes）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on this worktree branch

## ACR — Track Q（copy from `plans/retrieve-graph-quality.md` / spec）

bounded-context-guardian: yes — retrieval / extraction / projection stay capability slices; no Host context-assembly module; no technical-layer top-level dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception for the stack; each slice adds tests before code (writing-plans).
error-handling-enforcer: yes — skip vs fail-open vs `ConfigError` named per slice; embed hard-fail unchanged; EXIT on skip/fail-open.
complexity-anti-drift: yes — each slice is a helper on the existing assembler or extract/drain CLI, not a god-file rewrite.
minimal-change-verifier: yes **for this spec as one contract**; implementation **must** be one logical task per tracer bullet (writing-plans). Do not land remaining slices in one commit.

## ACR — Track E（copy from `plans/p0-eval.md` / spec）

bounded-context-guardian: yes — eval is an offline extraction-quality capability; no Host assembly; no technical-layer top-level dirs (`controllers`/`services`); isolation from `src/tools` and retrieve.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — ConfigError for model-id clash and pre-lock release gate; typed loader errors; EXIT on fatal is rerun/fix config; gate fail is exit 2 not swallowed; no empty catch in the contract.
complexity-anti-drift: yes — scoring, filter, baseline, gate, and CLI stay separate; CLI composes them, does not inline a god scorer.
minimal-change-verifier: yes — one logical task per tracer bullet below; not mixed with retrieve P@5 or extract pipeline behaviour.

## 已锁定决策

1. 本轮不改两仓共享「跨仓对齐基线」章节。
2. 不与 fin 联调、不接收 fin 推送块；不二次切分验收留阶段 2。
3. 「真实数据」= p0-eval gold snapshot + gold-build，不是 EDGAR/fin 语料。Fin 入库推送是阶段 2。
4. 质量栈本轮只做 T2–T5；T6 mode bundles 及之后下一轮。
5. p0-eval spec/plan 从 `docs/p0-eval-llm-gold` 带进本 worktree（`plans/p0-eval.md`、`specs/p0-eval.md`）；本 PR 允许把这两份 SSOT 合入 main，实现按 Track E 子弹推进。
6. Tracker 本地 markdown。

## Baseline（本轮不重做）

| 轨  | 已在 main                                     | Evidence                                            |
| --- | --------------------------------------------- | --------------------------------------------------- |
| Q   | Temporary LLM rerank（quality T1 / slice 0）  | PR #118 · `plans/retrieve-rerank-llm.md` **closed** |
| Q   | Graph-priority + 质量栈契约                   | PR #94 / #117                                       |
| Q   | Community summaries（quality T9）             | `plans/retrieve-community.md` **closed**            |
| E   | ADR-0002 / CONTEXT **extraction F1** 已 flush | 不是 tracer bullet                                  |

## Frontier（默认第一刀）

- **Track Q：** Q-T3 / Q-T4 / Q-T5 并行开工（无需外部 rerank URL）。Q-T2 `[parallel]` 可同回合做，但**不是**本轮默认产品第一刀。
- **Track E：** E-T1 gold loader — 这就是本仓锁定的「真实数据」路径。其后 E-T2 / E-T3 在 E-T1 之后并行。

## Tasks (ordered by dependency)

两轨独立编号别名（Q-T\* / E-T\* 对齐源计划）；下方 1–12 为跨轨顺序号。`[blocks:]` 使用别名，避免与跨轨序号混淆。

### Track Q — retrieve-graph-quality executable subset

1. **[Track Q] Dedicated rerank HTTP (Q-T2)** — tag: `[implementation]`
   - **Inherits:** `specs/retrieve-graph-quality.md` SC1–SC3, slice 1: 同一 retrieve hook as quality T1; default off; missing URL skip not `degraded`; throw fail-open + `degraded`; not Host chat model.（源计划 `plans/retrieve-graph-quality.md` T2。）
   - **Surface:** retrieve orchestrator rerank port; config/env for HTTP endpoint. Temporary LLM adapter remains until this bullet replaces it on the hook.
   - **Acceptance:** off → identical to post-T1 order; on + no URL → skip, no `degraded`; fake HTTP permutation then `limit`; **no live HTTP in `npm test`**（禁止 dedicated live HTTP）。
   - Status: [ ] pending
   - [parallel]
   - [blocks: none] — quality T1 already on main

2. **[Track Q] Projection GC (Q-T3)** — tag: `[implementation]`
   - **Inherits:** spec SC4, slice 2: ledger delete/retire → drain removes projection by id; empty graph still backfill; no graph tombstone as primary scheme. ADR-0001: Neo4j not SoR.
   - **Surface:** projection outbox / drain CLI (existing graph projection path).
   - **Acceptance:** after ledger delete and drain, Neo4j has no node/edge for that id (same Neo4j test style as the graph-arm suite); backfill of an empty graph still works.
   - Status: [ ] pending
   - [parallel]

3. **[Track Q] Self-loop extract reject (Q-T4)** — tag: `[implementation]`
   - **Inherits:** spec SC5, slice 3: row-level reject; not `--only-failed` force re-extract; no orphan entity for discarded loops.
   - **Surface:** extract CLI / triple write path.
   - **Acceptance:** self-loop is recorded as reject, no graph edge, `--only-failed` does not require re-extract; `npm test` exit 0.
   - Status: [ ] pending
   - [parallel]

4. **[Track Q] Persist `merged_into` (Q-T5)** — tag: `[implementation]`
   - **Inherits:** spec SC6, slice 4; P0c soft-merge; triples FK unchanged; `resolveCanonicalId` is the production read path.
   - **Surface:** extract merge/write path; entities ledger.
   - **Acceptance:** loser row stores `merged_into` = survivor; second extract is idempotent on that pointer (Postgres test helper already used by extract tests).
   - Status: [ ] pending
   - [parallel]

### Track E — p0-eval（pending 全收，Acceptance 继承 `plans/p0-eval.md`）

ADR-0002 and CONTEXT **extraction F1** are already flushed (not a tracer bullet).

5. **[Track E] Gold types + snapshot/gold loader (E-T1)** — tag: `[implementation]`
   - **Inherits:** spec A8, A9, SC8, SC11: match key is case-fold+trim heads/tails + extract `normalizeRelation` for `relation_norm`; snapshot 10–40 chunks; every gold triple has provenance; missing provenance is a typed error; no merge into gold from a previous gold model on overwrite (overwrite behaviour is asserted with the CLI in E-T6 — loader still rejects malformed files).
   - **Surface:** extraction-adjacent eval capability (same family as `src/core/extraction`, not retrieve, not MCP tools).
   - **Acceptance:** a valid fixture snapshot+gold loads; a gold triple without provenance is a typed error; snapshot size outside 10–40 fails validation; `npm test` path for this loader does not call a live LLM.
   - Status: [ ] pending
   - [blocks: none]

6. **[Track E] Three-axis scoring (E-T2)** — tag: `[implementation]`
   - **Inherits:** spec SC4–SC7, A1: micro-F1 exact match on the pinned key; schema rate vs ALLOWED; hallucination = evidence span not a substring; five error types diagnostic only.
   - **Surface:** same eval capability as E-T1.
   - **Acceptance:** the SC4 hand-computed F1 case passes; UNMAPPED lowers schema rate; non-substring evidence counts as hallucinated; each mis-prediction gets exactly one error type.
   - Status: [ ] pending
   - [parallel]
   - [blocks: E-T1]

7. **[Track E] Eval filter (E-T3)** — tag: `[implementation]`
   - **Inherits:** spec A4, SC10: code filter; ALLOWED imported from extraction vocabulary; reject reasons no-grounding / relation-not-norm / entity-not-normalized / negated.
   - **Surface:** same eval capability; vocabulary module already on main.
   - **Acceptance:** accept path plus each reject reason has a test; grep shows no hard-coded ALLOWED copy inside the filter module.
   - Status: [ ] pending
   - [parallel]
   - [blocks: E-T1]

8. **[Track E] Baseline append, steady state, atomic write (E-T4)** — tag: `[implementation]`
   - **Inherits:** spec A2, A10, SC12, SC13, SC16: Bootstrap records only; adjacent F1 delta ≤ 0.05 is ready-to-lock; concurrent writers do not leave truncated JSON.
   - **Surface:** eval capability + `gold-set/` (or env override path).
   - **Acceptance:** append records three axes; 0.05 boundary is tested both ways; two concurrent appends leave valid JSON; release-gate refuse-until-lock can live here or in E-T5 but must exist before E-T6.
   - Status: [ ] pending
   - [blocks: E-T2]

9. **[Track E] PR drift gate + Release absolute gate (E-T5)** — tag: `[implementation]`
   - **Inherits:** spec A3, SC14, SC15: PR is LLM-free; missing baseline passes; |ΔF1| > 0.05 → fail; Release reads thresholds from baseline, any axis fail fails; error types never gate.
   - **Surface:** eval capability (pure functions; CLI wires flags in E-T6).
   - **Acceptance:** drift pass/fail at ±0.05; first run with no baseline passes; absolute pass/fail per axis; thresholds not hard-coded in the gate module.
   - Status: [ ] pending
   - [blocks: E-T4]

10. **[Track E] Eval CLI (E-T6)** — tag: `[implementation]`
    - **Inherits:** spec A6, A11, A12, A14, A16, SC3, SC9, SC19, SC20: flags gold-build / audit-rejects / bootstrap / gate pr / gate release; gold and audit model ids ≠ extract; gold-build overwrites same snapshot+model+prompt-hash; audit labels are the three allowed values; isolation from tools/index/retrieve; exits 0/1/2 as spec.
    - **Surface:** existing CLI family (`extract`, `eval-retrieve`) — new eval entry, not an MCP tool.
    - **Acceptance:** subprocess tests cover unknown flag → 2, model-id clash → 1, `--gate pr` with no baseline → 0, `--gate release` before lock → 1; fake LLM gold-build overwrite drops leftover triples; eval entry does not import `src/tools` or `src/index`.
    - Status: [ ] pending
    - [blocks: E-T3, E-T5]

11. **[Track E] Postgres eval integration (E-T7)** — tag: `[implementation]`
    - **Inherits:** spec A15: read existing extraction tables only; loud skip if Postgres unreachable.
    - **Surface:** existing spec-2 PG test isolation / `extraction_records` + triples.
    - **Acceptance:** with Postgres up, a persisted extract batch can be scored; with Postgres down, the suite skips loudly (documented Validation), not a silent pass.
    - Status: [ ] pending
    - [parallel]
    - [blocks: E-T6]

12. **[Track E] Frozen snapshot v1 + CI scripts + runbook (E-T8)** — tag: `[implementation]`
    - **Inherits:** spec A5, A13, SC8, SC18: 10–40 chunk snapshot in git; `gate:pr` / `gate:release` scripts; Bootstrap-period PR path prints numbers and does not fail on F1 magnitude; runbook: gold-build → audit → bootstrap → lock thresholds → observe gates. Live LLM gold-build is documented, not required for `npm test`.
    - **Surface:** `gold-set/`, `package.json` scripts, operator runbook docs.
    - **Acceptance:** snapshot size in range; `npm run gate:pr` and `gate:release` invoke the eval CLI; runbook names the command sequence and the “new ruler” rule (extract model must not rewrite gold); `npm test` still green without gold-model credentials.
    - Status: [ ] pending
    - [parallel]
    - [blocks: E-T6]

## 不在本计划范围

- Track Q 源计划剩余：**T6** mode bundles、**T7** neighboring chunk evidence、**T8** node embedding in retrieve、**T10** causal relations / fact supersession、**T11** optional projection wait（T9 community 已在 main，本轮不重做）。
- **阶段 2：** 接收 fin 入库推送、二次切分验收、与 fin 联调。
- **fin A1–A7**（fin 侧入库 / 推送契约，不在本 worktree 执行）。
- 改两仓共享「跨仓对齐基线」章节。
- 把 extract pipeline 行为写进 Track E 子弹；把 retrieve P@5 写进 Track E 子弹。
- Dedicated rerank 的 live HTTP 进入 `npm test`。
- GitHub issues / `gh issue create`。

## 关联工件

| 角色                | 路径                                                       |
| ------------------- | ---------------------------------------------------------- |
| Track Q spec        | `specs/retrieve-graph-quality.md`                          |
| Track Q 源计划      | `plans/retrieve-graph-quality.md`                          |
| Track E spec        | `specs/p0-eval.md`                                         |
| Track E 源计划      | `plans/p0-eval.md`                                         |
| 本文件（执行 SSOT） | `plans/2026-09-01-stage1-iknow-executable.md`              |
| Operator index（Q） | `docs/handoff/wayfinder-tickets/retrieve-graph-quality.md` |

## 待写入 (persist)

(none — 不新开术语；CONTEXT / ADR-0002 已随 p0-eval spec flush)

## End of round

两轨全部子弹落地后：对整轮 impl diff 做 code-review（Standards + Spec），对照本计划与两份 spec，再 `verification-before-completion`。单票仍走 header 的 per-ticket loop（含该票的 code-review）。Claim：只改本文件 Status，不改 GitHub。
