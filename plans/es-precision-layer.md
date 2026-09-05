# Plan: Elasticsearch 精度层落地（T14）

**Status（2026-09-04）：** PR [#175](https://github.com/winter6205/iknow-memory/pull/175) 已合入 `main`。tracker [#135](https://github.com/winter6205/iknow-memory/issues/135) 已关。下方子弹原 markdown 滞后，以 PR 与 `docs/handoff/2026-09-03-es-precision-layer-validation.md` 为准（SC-1/2/3 真实 ES 集群曾 `not-run`）。

**Goal:** 词法检索生产载体从 Postgres `simple` FTS 迁到 Elasticsearch 精度层（中文分词 + 真 Okapi BM25 + 短语 + 字段加权），词法能力接入实体种子定位（向量+词法候选 RRF 融合）与回退补位两处，Postgres 侧词法实现摘除并归档。

**Approach:** 先小步对齐测试替身分词（T1），再搭 ES 精度层骨架与双写（T2–T4），然后接进两个落点（T5 种子融合、T6 Host 词法臂），Postgres 词法臂摘除走 expand→migrate→contract（T7），最后消融扩容与文档归档收尾（T8–T9）。T2 有一个 implementation 前的部署决策（D1）。

**Spec link:** `specs/es-precision-layer.md`（ACR 复审 PASS，5/5 yes）
**Tracker:** GitHub issues（operator 指示本轮不开 issue → 本计划仅落 `plans/` 本地文件，票由实施 agent 直接认领；不渲染 blocking edges，依赖关系以本文件 `[blocks:]` 为准。）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch（分支：`feat/es-precision-layer` worktree）

## Tasks (ordered by dependency)

1. **测试替身分词对齐（memory-backend tokenize 接 Intl.Segmenter）** — tag: `[implementation]`
   - **Inherits:** spec SC-9「对连续中文串 tokenize 后词元数 ≥ 2，中英文混合、单字查询、纯标点输入有单测覆盖」； Boundaries「memory-backend 保留为测试替身，仅补分词对齐」。
   - **Surface:** `src/core/storage/memory-backend.ts`（`tokenize()`，`searchLexical`）。
   - **Acceptance:** `npm test` 绿；新增单测断言连续中文串切出 ≥2 词元；既有英文路径行为不变（既有词法测试不改动仍绿）。
   - Status: [x] complete — PR #175

2. **ES 部署决策与本地栈** — tag: `[decision]`
   - **Inherits:** spec Confirms with human「ES 部署形态（单机 docker / 集群）与 analysis-ik 插件安装方式——实施前确认一次」。
   - **Surface:** 部署侧（docker compose / 运行环境），产出 `docs/runbooks/es-precision-layer.md` 草稿（部署、插件、索引建立命令）。
   - **Acceptance:** operator 确认部署形态；ES 8.x + analysis-ik 在目标环境可启动，`_analyze` 对连续中文返回 ≥2 token（SC-2 引擎侧前置）；runbook 草稿提交。
   - Status: [x] complete — PR #175

3. **ES 精度层模块骨架与 chunk 索引双写** — tag: `[implementation]`
   - **Inherits:** spec Boundaries「ES 索引为派生索引，权威数据仍在 Postgres，双写沿用 `(source_ref, contentIdentity)` 幂等键」；「索引期 `ik_max_word`、查询期 `ik_smart`」；「凭据仅经 env（`GRAPHRAG_MEMORY_ES_*`）」； spec Inherits「`GraphragEnv` 配置加载模式」。
   - **Surface:** `src/config.ts`（`GraphragEnv` 扩展）、`src/core/storage/backend.ts`（`LexicalStorageBackend` 缝）、新精度层模块（bounded context: storage 层新实现）、push 入库链路。
   - **Acceptance:** 配置 ES 后 push 双写成功（Postgres + ES 索引可查同文档）；ES 写失败不阻断权威写入；unconfigured 时全链路行为与现状一致（loud-skip）；k1/b、phrase/field_boost 开关进 `RetrieveConfig`，非法值 typed `ConfigError`。集成测试覆盖三态（SC-5 双态 + 双写失败）。
   - Status: [x] complete — PR #175
   - [blocks: T2]

4. **Host 词法臂换引擎（回退补位落点）** — tag: `[implementation]`
   - **Inherits:** spec Objective 第 2 条「Host 排序结构不变——图命中占前排，空缺由 chunk 级向量臂 + ES 词法臂 RRF 补位」； SC-1 / SC-3 / SC-4。
   - **Surface:** `src/core/retrieval/optional-arms.ts`（bm25 臂解析）、`src/core/retrieval/index.ts`（编排）、精度层模块。
   - **Acceptance:** 中文词法召回验收（SC-1：语义不相近共享词元查询 top-5 命中，关 `cjk_segmentation` 后不命中）；k1 改变固定 fixture 排序（SC-3）；phrase / field_boost 开关产生可观测排序差异（SC-4）。
   - Status: [x] complete — PR #175
   - [blocks: T3]

5. **实体索引与种子定位 RRF 融合** — tag: `[implementation]`
   - **Inherits:** spec Objective 第 1 条「图臂种子由向量路（`seedEntitiesByEmbedding`）+ 词法路（ES 实体索引：canonical_name + 别名）两路候选经 RRF（`rrfFuse`，k=60）融合产生」；「两次 RRF 独立，实体 vs chunk 粒度，互不投票」； Boundaries「实体索引同步刷新与重灌」； SC-10。
   - **Surface:** `src/core/retrieval/neo4j-graph-arm.ts` / `graph-arm.ts`（seed 生成）、精度层模块（实体索引）、push 入库链路（实体投影）。
   - **Acceptance:** SC-10 三态：两路融合、词法关闭时种子列表与纯向量现状一致、词法失败 fail-open（degraded 命名条目）；种子接口签名不变（`seedEntitiesByEmbedding` 消费点不动）；固定 fixture 专名查询融合后种子命中率不低于纯向量。
   - Status: [x] complete — PR #175
   - [blocks: T3]（可 [parallel] 于 T4）

6. **消融矩阵扩容** — tag: `[implementation]`
   - **Inherits:** spec SC-7「10+ 配置含新键开关，缺配置 = 0，原始值与中位数落盘，行为与 `specs/retrieval-stack.md` §B1 一致」。
   - **Surface:** `src/cli/eval.ts`、eval 配置集。
   - **Acceptance:** `cjk_segmentation` / `phrase` / `field_boost` / `keyword_bm25` 各自开关进入配置集并产出可观测差异报告；消融运行命令全绿。
   - Status: [x] complete — PR #175
   - [blocks: T4, T5]

7. **Postgres 词法臂摘除（expand→migrate→contract 的 contract 步）** — tag: `[implementation]`
   - **Inherits:** spec SC-6「`ts_rank_cd` / `LEXICAL_TSQUERY` / `content_tsv` 全仓 grep 为零命中，`docs/archive/` 归档件除外」； Boundaries「schema 迁移一份」。
   - **Surface:** `src/core/storage/pgvector-backend.ts`、schema 迁移、`docs/archive/`。
   - **Acceptance:** 全仓 grep 零命中（归档件除外）；schema 迁移往返可验证（摘除生成列，重跑不报错）；`npm test` 全绿；被摘代码快照归档进 `docs/archive/`。
   - Status: [x] complete — PR #175
   - [blocks: T4]

8. **文档对齐与归档** — tag: `[implementation]`
   - **Inherits:** spec Changes「`docs/CONTEXT.md` precision layer 词条与代码一致化」「新增 runbook：ES 索引（chunk + entity）建立与重灌步骤」； Boundaries「被 supersede 的 spec 正文移 `docs/archive/`」。
   - **Surface:** `docs/CONTEXT.md`、`docs/runbooks/`、`specs/bm25-retrieve.md`、`docs/archive/`。
   - **Acceptance:** CONTEXT.md precision layer 词条表述与落地行为一致（种子环节两路融合在案）；`specs/bm25-retrieve.md` 移入 `docs/archive/` 并在原位留指路；runbook 完整覆盖部署→插件→索引建立→重灌。
   - Status: [x] complete — PR #175
   - [blocks: T7]

9. **端到端验收与收尾** — tag: `[implementation]`
   - **Inherits:** spec 全部 Success Criteria； per-ticket loop 收尾要求。
   - **Surface:** 全仓。
   - **Acceptance:** SC-1–SC-10 逐条过验并记录命令与结果；`npm test` 全绿；一轮 code review phase（整轮改动）完成后 commit 收口。
   - Status: [x] complete — PR #175
   - [blocks: T6, T7, T8]

## ACR

spec `specs/es-precision-layer.md` 复审块（第二轮，OVERALL: PASS）：

- bounded-context-guardian: yes — ES 走既有 `LexicalStorageBackend` 缝，Postgres 仍为权威源；import 方向不变。
- defensive-contract-validator: yes — 五类边界测试表映射新键；unconfigured/failed/empty 三分；SC-10 三态。
- error-handling-enforcer: yes — 种子 fail-open / Host 词法缺席命名条目；双写失败不阻断权威写入；typed ConfigError。
- complexity-anti-drift: yes — 复用 `rrfFuse`；摘除保持单一词法实现；两次 RRF 粒度分离非重复逻辑。
- minimal-change-verifier: yes — 向量/图/rrfFuse/rerank/graph-priority 不动；diff 限定词法载体 + 配置 + 归档 + schema 迁移一份。

## 待写入

(none) — 本计划未引入或改判 `docs/CONTEXT.md` 已有术语；种子融合为既有 **precision layer** 词条（entity-finding stage）的兑现，非新术语。
