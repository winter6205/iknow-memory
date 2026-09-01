# Plan: 阶段 1 iknow-memory 可执行子集（质量栈 T2–T5 + p0-eval）

**Goal:** 在不联调 fin、不改跨仓基线的前提下，并行推进检索质量栈剩余可切的刀，以及抽取层 **extraction F1** 的 LLM gold 评测（本仓「真实数据」）。
**Approach:** 一条 worktree、一张计划、两条互不共享可变状态的轨道。Track Q 执行 `plans/retrieve-graph-quality.md` 的 T2–T5：T3/T4/T5 无外部 HTTP，作为质量栈默认第一刀并行；T2 专用 rerank HTTP 与它们并行但不是本轮首选。Track E 执行 `plans/p0-eval.md` 全文 pending 弹：真实数据 = 冻结 10–40 chunk snapshot 上的 gold-build，不是等 fin 入库推送。默认第一刀 Track E 的 T1（gold loader）与 Track Q 的 T3/T4/T5 可同时开。
**Spec link:** `specs/retrieve-graph-quality.md`；`specs/p0-eval.md`（本 worktree 从 `docs/p0-eval-llm-gold` 带入，允许随本 PR 合入 main）
**Tracker:** FALLBACK — 本地本文件。操作者本轮禁止 GitHub issue；`plans/retrieve-graph-quality.md` 原本即以本地 markdown 为 SSOT。
**Per-ticket loop (all bullets):** tdd → `npm test` + `npm run build`（无 live Anthropic / 无 live gold LLM）→ code-review → verification-before-completion → one commit on `docs/stage1-iknow-executable-plan`（或从其再切的 ticket 分支）

## ACR — Track Q（retrieve-graph-quality T2–T5）

bounded-context-guardian: yes — retrieval / extraction / projection 保持能力切片；无 Host 装配模块；无 `controllers/` / `services/`。
defensive-contract-validator: yes — 各 slice 先测后改；T2 无 live HTTP；T3 沿用既有 Neo4j 测试风格。
error-handling-enforcer: yes — skip vs fail-open vs `ConfigError` 按 slice 具名；rerank 缺 URL 为 skip 且不标 `degraded`。
complexity-anti-drift: yes — 每弹一个 helper / CLI 缝，不重写 `assembleRetrievalResult` 成上帝文件。
minimal-change-verifier: yes — 一弹一 commit；不把剩余质量栈一次落地。

## ACR — Track E（p0-eval）

bounded-context-guardian: yes — 离线抽取质量评测；不进 Host；隔离 `src/tools` 与 retrieve。
defensive-contract-validator: yes — spec Testing Strategy 的五类边界；loader/scoring/filter/gate 各弹补测。
error-handling-enforcer: yes — 模型 id 冲突与未 lock 的 release gate 用 `ConfigError`；exit 0/1/2 按 spec；无空 catch。
complexity-anti-drift: yes — scoring / filter / baseline / gate / CLI 分开，CLI 只组合。
minimal-change-verifier: yes — 不混 retrieve P@5、不改 extract 管线行为。

## 已锁定决策

1. 本轮**不改**两仓共享「跨仓对齐基线」章节。
2. 不与 fin 联调、不接收 fin 推送块；「不二次切分」留阶段 2。
3. 本仓「真实数据」= p0-eval 的冻结 snapshot + LLM gold-build（`specs/p0-eval.md`），**不是** fin 的 EDGAR 评测数据集，也不是入库推送。
4. 质量栈本轮只做 T2–T5；T6 mode bundles 及之后下一轮。
5. `plans/p0-eval.md` 与 `specs/p0-eval.md` 从 `docs/p0-eval-llm-gold` 带进本 worktree；本 PR 可以把这两份 SSOT 合入 main，实现按 Track E 子弹走。
6. T2 需要 HTTP 端点时：缺 URL → skip、不 `degraded`；`npm test` 只用 fake HTTP。没有现成端点就不把 T2 当本轮第一刀。

## Tasks (ordered by dependency)

### Track Q — 质量栈

1. **[parallel] Projection GC** — tag: `[implementation]`
   - **Inherits:** `plans/retrieve-graph-quality.md` T3；spec SC4；ADR-0001 Neo4j 非 SoR。ledger delete/retire → drain 按 id 去掉投影；空图仍可 backfill。
   - **Surface:** 既有 projection outbox / drain CLI。
   - **Acceptance:** ledger 删除并 drain 后 Neo4j 无该 id 的 node/edge（同 graph-arm 测试风格）；空图 backfill 仍可用。
   - Status: [ ] pending
   - [parallel]
   - **质量栈默认第一刀之一**

2. **[parallel] Self-loop extract reject** — tag: `[implementation]`
   - **Inherits:** 同文件 T4；spec SC5。行级 reject；`--only-failed` 不强制再抽；不产生孤儿 entity。
   - **Surface:** extract CLI / triple 写路径。
   - **Acceptance:** self-loop 记为 reject、无图边；`npm test` exit 0。
   - Status: [ ] pending
   - [parallel]
   - **质量栈默认第一刀之一**

3. **[parallel] Persist `merged_into`** — tag: `[implementation]`
   - **Inherits:** 同文件 T5；spec SC6。P0c soft-merge；triples FK 不变；`resolveCanonicalId` 仍是生产读路径。
   - **Surface:** extract merge/write；entities ledger。
   - **Acceptance:** loser 行 `merged_into` = survivor；二次 extract 对该指针幂等（沿用既有 Postgres extract 测试 helper）。
   - Status: [ ] pending
   - [parallel]
   - **质量栈默认第一刀之一**

4. **[parallel] Dedicated rerank HTTP** — tag: `[implementation]`
   - **Inherits:** 同文件 T2；spec SC1–SC3。与临时 LLM adapter 同一 retrieve hook；默认关；缺 URL skip 且不 `degraded`；throw fail-open + `degraded`。
   - **Surface:** retrieve orchestrator rerank port；config/env 中的 HTTP endpoint。
   - **Acceptance:** 关闭时顺序与 post-T1 相同；开且无 URL → skip；fake HTTP 置换后再 `limit`；`npm test` 无 live HTTP。
   - Status: [ ] pending
   - [parallel]
   - [blocks: retrieve-graph-quality T1（已 done #118）]

### Track E — p0-eval（真实数据 / extraction F1）

5. **Gold types + snapshot/gold loader** — tag: `[implementation]`
   - **Inherits:** `plans/p0-eval.md` T1；spec A8, A9, SC8, SC11。
   - **Surface:** 抽取旁路 eval 能力（与 `src/core/extraction` 同族，不是 retrieve，不是 MCP tool）。
   - **Acceptance:** 合法 fixture snapshot+gold 能加载；缺 provenance 的 gold triple 为具名错误；snapshot 尺寸越出 10–40 校验失败；本 loader 的 `npm test` 路径不打 live LLM。
   - Status: [ ] pending
   - **真实数据默认第一刀**
   - [blocks: none]

6. **[parallel] Three-axis scoring** — tag: `[implementation]`
   - **Inherits:** `plans/p0-eval.md` T2；spec SC4–SC7, A1。
   - **Surface:** 与 T5 同一 eval 能力。
   - **Acceptance:** spec SC4 手算 F1 用例通过；UNMAPPED 降低 schema rate；非 substring evidence 计 hallucination；每条误预测恰好一个 error type。
   - Status: [ ] pending
   - [parallel]
   - [blocks: T5]

7. **[parallel] Eval filter** — tag: `[implementation]`
   - **Inherits:** `plans/p0-eval.md` T3；spec A4, SC10。ALLOWED 从抽取词表 import，禁止模块内硬编码副本。
   - **Surface:** 同一 eval 能力；词表模块已在 main。
   - **Acceptance:** accept 路径与每个 reject reason 均有测试；grep 证明 filter 模块无硬编码 ALLOWED 副本。
   - Status: [ ] pending
   - [parallel]
   - [blocks: T5]

8. **Baseline append, steady state, atomic write** — tag: `[implementation]`
   - **Inherits:** `plans/p0-eval.md` T4；spec A2, A10, SC12, SC13, SC16。
   - **Surface:** eval 能力 + `gold-set/`（或 env 覆盖路径）。
   - **Acceptance:** append 记录三轴；0.05 边界正反测；两次并发 append 留下合法 JSON；release-gate 未 lock 即拒必须在 T9 之前存在。
   - Status: [ ] pending
   - [blocks: T6]

9. **PR drift gate + Release absolute gate** — tag: `[implementation]`
   - **Inherits:** `plans/p0-eval.md` T5；spec A3, SC14, SC15。PR 无 LLM；缺 baseline 通过；error types 永不门禁。
   - **Surface:** eval 纯函数（CLI 在 T10 接线）。
   - **Acceptance:** ±0.05 drift 过/不过；无 baseline 首跑通过；每轴绝对过/不过；阈值不硬编码在 gate 模块。
   - Status: [ ] pending
   - [blocks: T8]

10. **Eval CLI** — tag: `[implementation]`
    - **Inherits:** `plans/p0-eval.md` T6；spec A6, A11, A12, A14, A16, SC3, SC9, SC19, SC20。
    - **Surface:** 既有 CLI 族（`extract`、`eval-retrieve`）上的新 eval 入口，不是 MCP tool。
    - **Acceptance:** 未知 flag → 2；模型 id 冲突 → 1；`--gate pr` 无 baseline → 0；`--gate release` 未 lock → 1；fake LLM gold-build overwrite 丢掉旧模型残留 triple；eval 入口不 import `src/tools` 或 `src/index`。
    - Status: [ ] pending
    - [blocks: T7, T9]

11. **[parallel] Postgres eval integration** — tag: `[implementation]`
    - **Inherits:** `plans/p0-eval.md` T7；spec A15。只读既有 extraction 表；PG 不可达 loud skip。
    - **Surface:** 既有 spec-2 PG 测试隔离 / `extraction_records` + triples。
    - **Acceptance:** PG 可用时能对已持久化 extract batch 打分；PG 宕机时套件 loudly skip，不是静默通过。
    - Status: [ ] pending
    - [parallel]
    - [blocks: T10]

12. **[parallel] Frozen snapshot v1 + CI scripts + runbook** — tag: `[implementation]`
    - **Inherits:** `plans/p0-eval.md` T8；spec A5, A13, SC8, SC18。Live LLM gold-build 写在 runbook，不进 `npm test`。
    - **Surface:** `gold-set/`、`package.json` scripts、operator runbook。
    - **Acceptance:** snapshot 尺寸在范围内；`npm run gate:pr` / `gate:release` 调 eval CLI；runbook 写明 gold-build → audit → bootstrap → lock → observe，以及 extract 模型不得改写 gold；无 gold 凭证时 `npm test` 仍绿。
    - Status: [ ] pending
    - [parallel]
    - [blocks: T10]

## 不在本计划范围

- 质量栈 T6 mode bundles、T7 neighbor chunks、T8 node embedding、T10 causal supersession、T11 wait-for-drain（T9 community 已 done）
- 阶段 2（D）与 fin 推送 / 不二次切分联调
- fin A1–A7 / A8 EDGAR 数据集
- retrieve P@5（`specs/retrieve-p5.md`）
- 用新 extract 模型重写 gold；人工标注

## 关联工件

| 类型                 | 路径                              |
| -------------------- | --------------------------------- |
| 本轮执行 SSOT        | 本文件                            |
| 质量栈计划           | `plans/retrieve-graph-quality.md` |
| p0-eval 计划（带入） | `plans/p0-eval.md`                |
| p0-eval spec（带入） | `specs/p0-eval.md`                |
| 质量栈 spec          | `specs/retrieve-graph-quality.md` |

## End of round

Track Q 的 T2–T5 与 Track E 的 T1–T8 全部落地后，分别对照各自 spec 做 Standards + Spec code-review，再 `verification-before-completion`。禁止把两条轨道揉进同一个 commit。
