# Spec: Elasticsearch 精度层落地（T14）

> 继承 `specs/retrieval-stack.md`（定档 B）与 C-1 改判。票源：`plans/retrieval-stack.md` T14；tracker：iknow-memory #135。

## Objective

把词法检索的生产载体从 Postgres `simple` 全文配置迁到 Elasticsearch 精度层，使中文语料下词法臂真实可用。用户是检索服务调用方（fin Host 与 eval CLI）：中文查询当前词法召回趋近于零（连续中文整段成为单个词元，查询与内容词元几乎不可能相等），本 spec 交付后中文查询在纯词法路径也能命中目标 chunk。同时交付短语查询与字段加权两项词法能力，四项能力（中文分词、Okapi BM25、短语、字段加权）在同一引擎、同一词元流上生效。

## Boundaries

- **Does:**
  - 新增 Elasticsearch 8.x 精度层模块（新依赖 `@elastic/elasticsearch`），索引期与查询期同源分析器：索引期 `ik_max_word`、查询期 `ik_smart`（analysis-ik 插件）。
  - ES 索引作为**派生索引**：权威数据仍在 Postgres；索引可随时删除重灌；写入链路双写（Postgres 成功后写 ES，沿用 `(source_ref, contentIdentity)` 幂等键语义）。
  - 排序承载真 Okapi BM25（k1 / b 可调，进 `RetrieveConfig`），短语查询（`match_phrase`）与字段加权（多字段 `boost`）参与排序。
  - 现有 Postgres 词法臂整体摘除：`content_tsv` 生成列、`ts_rank_cd` 排序、`LEXICAL_TSQUERY` 删除（schema 迁移）。
  - dev/test 内存后端保留，`tokenize()` 接入 `Intl.Segmenter`（CJK 词典切词），使测试替身与精度层切词行为对齐；它是测试形态，不违反单一词法实现约定。
  - 降级语义：ES unconfigured → 词法臂 loud-skip，不设 degraded；configured-but-failing at call time → `degraded=true` 并在 `degraded_reasons` 命名条目。
  - 能力键沿用 `CAPABILITY_REGISTRY` 枚举：`cjk_segmentation`、`keyword_bm25`、`phrase`、`field_boost` 可独立开关并纳入消融矩阵配置。
  - 词法能力在两个阶段接线的落点：实体种子定位（见 Open Questions 决策）与回退补位（现有 RRF 路径换数据源）。
  - **归档纪律**：被摘除的词法实现、被 supersede 的 spec 正文、替换下来的 runbook，一律移动到 `docs/archive/` 归档，不在源代码仓库里直接删除。
- **Confirms with human:**
  - ES 部署形态（单机 docker / 集群）与 analysis-ik 插件安装方式——实施前确认一次。
  - 若 Open Questions 第 1 条选 (b)，词法参与种子定位的接口形状。
- **Out of this spec:**
  - 图臂（Neo4j PPR）、向量臂、RRF k 值、rerank、graph-priority 合流逻辑——全部不动。
  - 权威数据 schema 除摘除词法列外不变更；不引入第二套词法排序实现。
  - memory-backend 持久化、fin 侧 chunking——各有归属。

## Success Criteria

1. **中文词法召回**：向已入库中文 chunk 发起语义不相近、共享中文词元的查询，全能力开启时 top-5 含目标 chunk；同一 fixture 关闭 `cjk_segmentation` 后 top-5 不含该 chunk。命令：`npm run eval:stack -- --config zh-segment-off`（spec SC 验收口径）。
2. **词元断言**：对连续中文文本，精度层分析接口返回词元数 ≥ 2（=1 即失败）。
3. **真 BM25**：ES 侧排序使用 Okapi BM25，k1 / b 从 `RetrieveConfig` 读取并在查询中生效（改变 k1 在固定 fixture 上至少一次排序可观测变化）。
4. **短语与字段加权**：`phrase` 开启时 match_phrase 命中参与排序；`field_boost` 开启时字段 boost 改变同 fixture 排序——各对应一条消融配置的可观测差异。
5. **降级语义**：未配置 ES 时 retrieve 正常返回、词法臂缺席且无 degraded；配置了但 ES 不可达时返回 `degraded=true` 且 `degraded_reasons` 含 `keyword_bm25`。集成测试覆盖两态。
6. **单一实现**：Postgres 侧无残留词法排序代码（`ts_rank_cd` / `LEXICAL_TSQUERY` / `content_tsv` 全仓 grep 为零命中，`docs/archive/` 归档件除外）。
7. **消融矩阵**：10+ 配置含新键开关，缺配置 = 0，原始值与中位数落盘，行为与 `specs/retrieval-stack.md` §B1 一致。
8. **归档完整**：摘除物在 `docs/archive/` 有对应归档文件，PR diff 可追溯。
9. **测试替身对齐**：memory-backend 对连续中文串 tokenize 后词元数 ≥ 2，中英文混合、单字查询、纯标点输入有单测覆盖。

## Open Questions

1. **种子定位**（已决策 (a)，assumption gate 确认）：本轮文档改为承认"种子 = 向量相似度"（`seedEntitiesByEmbedding`），词法参与找种子列为将来增强，不在本 spec 范围。→ 已决，无遗留。
2. ES 部署形态与插件安装方式 → 移入 Confirms with human，实施前确认。

## Inherits / Changes

- **Inherits**：`specs/retrieval-stack.md` 定档 B 与 C-1/C-11 改判；`docs/CONTEXT.md` 已有 **BM25**、**precision layer**、**hybrid retrieval**、**degraded=true**、**RRF fusion (k=60)** 词条（本 spec 引用其定义，不另立）；`specs/retrieve-graph-priority.md` 的 Host 排序契约；`(source_ref, contentIdentity)` 幂等键；四规则 degraded 语义（§B3）；能力键枚举（`src/core/retrieval/types.ts` `CAPABILITY_REGISTRY`）；`GraphragEnv` 配置加载模式（`src/config.ts`，process.env > `.env.local`）；测试命令 `npm test`（vitest）。
- **Changes**：
  - 生产词法载体：Postgres FTS → Elasticsearch 精度层（`content_tsv` / `ts_rank_cd` / `LEXICAL_TSQUERY` 摘除，schema 迁移一份）。
  - `RetrieveConfig` 扩展：`k1`、`b`、phrase / field_boost 开关；`GraphragEnv` 增 ES 连接配置（`GRAPHRAG_MEMORY_ES_*`，凭据仅经 env，不入库不入码）。
  - 能力键 `cjk_segmentation` 从"有键无实现"变为有实现；消融矩阵配置集扩容。
  - `docs/CONTEXT.md` **precision layer** 词条的 "entity-finding stage" 表述刷新为与代码一致（种子 = 向量；词法在回退处在场，种子参与列为将来增强）。
  - 新增 runbook：ES 索引建立与重灌步骤。

## architecture-change-reviewer

- bounded-context-guardian: yes — 精度层是独立模块（词法能力单一职责），经既有 arm 接口接入，无反向依赖；Postgres 仍为权威源，方向不变。
- defensive-contract-validator: yes — 降级两态、unconfigured/failed/empty 三分、幂等双写、开关边界均有验收条目与测试计划。
- error-handling-enforcer: yes — configured-but-failing → degraded 命名条目；unconfigured → loud-skip；双写失败路径（ES 写失败不阻断权威写入，记 degraded）纳入边界。
- complexity-anti-drift: yes — 摘除旧词法臂使排序实现单一化；无第二套口径；新增配置项最少集。
- minimal-change-verifier: yes — 向量/图/RRF/rerank 不动；diff 限定在词法臂载体、配置扩展、归档移动；1 commit = 1 逻辑步交付。
