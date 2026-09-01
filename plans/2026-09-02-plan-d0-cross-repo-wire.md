# Plan: D0 — 跨仓缺口 1–6 联调（iknow-memory 侧执行切片）

**Goal:** 让 fin 能连上本进程：retrieve 输入不再被静默剥键、输出 `chunks` + `source_ref`、有可启动入口；并补上 push / 失效、B4 信封与 8 能力键，以及**对 fin 推送文本不做二次切分**。
**Approach:** 与 fin Plan C **并行**。本文件只写本仓子弹；fin 对侧在 fin 仓同名计划。ingest 工具可以保留给既有抽取路径，但 **fin 入库推送不得再走「Chunk then embed」的滑动切分**。默认第一刀：retrieve 输入 schema 明确接受并文档化 fin 将要发送的键（或提供别名），禁止未知键静默丢弃。
**Spec link:** fin `specs/corpus-retrieval.md` §B2–§B4（共享基线；本仓 `specs/retrieval-stack.md` 同名章节若已落盘则与之逐字一致）；ADR 0037 的改判（切分归 fin）
**配对计划:** fin `plans/2026-09-02-plan-d0-cross-repo-wire.md`（分支 `docs/plan-d0-cross-repo-wire`）
**Tracker:** FALLBACK — 本地本文件。不开 GitHub issue。
**Per-ticket loop (all bullets):** tdd → `npm test` + `npm run build`（无强制 live fin）→ verification-before-completion → one commit

## ACR

bounded-context-guardian: yes — 工具仍在 MCP tools 切片；不把 Host 装配或 fin 语料管道搬进本仓；无 `controllers/` / `services/` 顶层。
defensive-contract-validator: yes — 空查询 / 缺字段 / 过大批次 / 并发幂等 / 工具抛错五类在各弹补测；`npm test` 不依赖 fin 进程。
error-handling-enforcer: yes — 剥键改为拒绝或显式别名，禁止静默丢键；push/失效失败具名；skip vs fail-open 写清。
complexity-anti-drift: yes — push 与 ingest 分责：ingest 不承担 fin 块的二次切分。
minimal-change-verifier: yes — 一弹一 commit；不重做质量栈 T6+、不重做 p0-eval。

## 已锁定决策

1. 与 fin Plan C 并行；不二次切分对账用 fin **现有**样本，不等 A8。
2. 不在本仓做「清洗中心」；脏输入拒绝或具名失败。
3. 不重构 fin host 工具树。本仓可**新增** push / invalidation 工具（缺口 4），retrieve / ingest / echo 不借机大改结构。
4. 8 能力键权威拼写以 §B4 为准，内部配置名不得冒充对外键。

## Tasks (ordered by dependency)

1. **retrieve 输入：无静默剥键** — tag: `[implementation]`
   - **Inherits:** 缺口 1。当前 `retrieve` 为普通 `z.object`（无 `.strict()`），fin 曾发 `top_k` / `filter` / `document_id`。本弹必须让「未公布键」变为校验失败，或登记与 fin 适配器一致的别名后正规化到已公布字段（`limit` / `filters` 或 retrieve port 的 `query` + 过滤）。
   - **Surface:** 既有 `retrieve` 工具输入 schema。
   - **Acceptance:** 未知键不能再被默默丢掉（测试：多一个未公布键 → 失败或映射到已公布字段且日志可断言）；已公布键行为与现网 retrieve 一致；`npm test` 无 live fin。
   - Status: [ ] pending
   - **默认第一刀**
   - 配对：fin T1

2. **retrieve 输出：`chunks` + `source_ref`** — tag: `[implementation]`
   - **Inherits:** 缺口 2；§B4 `source_ref` 拼写与冻结单元级粒度。信封可继续带可选 `degraded`（B3）。
   - **Surface:** 既有 retrieve 工具结果装配。
   - **Acceptance:** 成功响应含 `chunks` 数组；每个用于引用的块带 `source_ref`（及文本字段，现为 `content`）；不把命中列表只放在 `hits` 且无 `chunks`。
   - Status: [ ] pending
   - [blocks: T1]
   - 配对：fin T2

3. **[parallel] 可启动的 MCP 入口** — tag: `[implementation]`
   - **Inherits:** 缺口 3。fin 曾写 `("iknow-memory", "serve")`，本仓 `bin` 仅有 `extract` / `consolidate`。本弹公布唯一 argv（`iknow-memory` stdio 或 `iknow-memory serve`），并与 fin T3 常量逐字一致。
   - **Surface:** 既有 package `bin` / CLI 入口族（与 `extract` 并列，不是新 MCP 工具）。
   - **Acceptance:** 文档化命令能拉起 MCP stdio；`npm test` 不要求真实 socket；未知子命令具名失败。
   - Status: [ ] pending
   - [parallel]
   - [blocks: none]
   - 配对：fin T3

4. **push：按幂等键存储 fin 块，不切分** — tag: `[implementation]`
   - **Inherits:** 缺口 4 + §B4 幂等键与「不二次切分」。这是给 fin `push_port` 的工具，**不是**把现有 `ingest` 改名为 push。`ingest` 描述中的 Chunk 不得用于这条路径。
   - **Surface:** MCP tools 切片内新工具（名称实现者定，但须在本弹 Acceptance 写进 README 或既有工具索引一处）。
   - **Acceptance:** 同一 (`source_ref`, 内容标识) 连推两次不新增第二份权威行；缺 B4 必填元数据拒绝整批；块文本原样落权威源。
   - Status: [ ] pending
   - [blocks: T3]
   - 配对：fin T4

5. **invalidation：关区间、不物理删除、幂等** — tag: `[implementation]`
   - **Inherits:** §B4 内容失效语义。
   - **Surface:** MCP tools 切片（可与 T4 同族，仍单独一 commit）。
   - **Acceptance:** 关闭后任何 `valid_at` 在关闭区间内的 retrieve 不得命中该块；第二次失效成功且记录可查；无物理 delete 作为主方案。
   - Status: [ ] pending
   - [blocks: T4]
   - 配对：fin T5

6. **信封 `degraded_reasons` 与 8 键公布** — tag: `[implementation]`
   - **Inherits:** 缺口 5；§B3 / §B4。对外枚举逐字八键，不得用 `bm25` / `graphEnabled` 冒充。
   - **Surface:** retrieve 信封与能力配置的对外投影（内部配置可保留，但对外键必须是 B4）。
   - **Acceptance:** 能力尝试失败时信封可带 `degraded` + `degraded_reasons`；有限枚举可被 fin 快照对齐；产品默认不要求关闭键。
   - Status: [ ] pending
   - [blocks: T2]
   - 配对：fin T6

7. **fin 推送路径关闭滑动切分** — tag: `[implementation]`
   - **Inherits:** 缺口 6；ADR 0037；§B4 不二次切分。`src/core/chunker.ts` 固定窗口不得再改写 T4 写入的块文本。
   - **Surface:** push 路径与（若仍被误连）ingest-from-fin 的分流。
   - **Acceptance:** 对 T4 写入的文本，retrieve 返回字节与写入相同；测试证明 push 路径不调用滑动切分。既有「对原始长文本 ingest」若仍切分，必须走另一入口且不用于 fin 联调。
   - Status: [ ] pending
   - [blocks: T4]
   - 配对：fin T7

## 不在本计划范围

- fin Plan C（EDGAR / §B1 规模）
- 质量栈 T6+、p0-eval 剩余弹
- 阶段 2 全量 D 验收、阶段 3 消融
- 改 fin 引用门；把 extract 管线行为塞进 retrieve
- GitHub issues

## 关联工件

| 类型           | 路径                                                       |
| -------------- | ---------------------------------------------------------- |
| fin 对侧       | fin 仓 `plans/2026-09-02-plan-d0-cross-repo-wire.md`       |
| 缺口表         | fin `docs/cross-repo/alignment-proposal.md`                |
| 质量栈（不混） | `plans/retrieve-graph-quality.md`                          |
| 基线 spec      | `specs/retrieval-stack.md` 跨仓对齐基线章节（若已在 main） |

## End of round

I-T1–I-T7 落地后对照缺口 1–6 与 §B4 做 code-review，再 `verification-before-completion`。与 Plan C、质量栈剩余弹分 commit、分 PR。
