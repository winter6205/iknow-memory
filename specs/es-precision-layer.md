# Spec: Elasticsearch 精度层落地（T14）

> 继承 `specs/retrieval-stack.md`（定档 B）与 C-1 改判。票源：`plans/retrieval-stack.md` T14；tracker：iknow-memory #135。

## Objective

把词法检索的生产载体从 Postgres `simple` 全文配置迁到 Elasticsearch 精度层，使中文语料下词法臂真实可用。用户是检索服务调用方（fin Host 与 eval CLI）：中文查询当前词法召回趋近于零（连续中文整段成为单个词元，查询与内容词元几乎不可能相等），本 spec 交付后中文查询在纯词法路径也能命中目标 chunk。同时交付短语查询与字段加权两项词法能力，四项能力（中文分词、Okapi BM25、短语、字段加权）在同一引擎、同一词元流上生效。

词法能力落在检索链**两处**（与 `docs/CONTEXT.md` **precision layer** 词条 "entity-finding stage + fallback stage" 一致）：

1. **实体种子定位（entity-finding stage，新增）**：图臂的种子由两路候选经 RRF（复用 `rrfFuse`，k=60）融合产生——向量路查实体 embedding 近邻（现有 `seedEntitiesByEmbedding`），词法路查 ES 实体索引（`canonical_name` + 别名字段，词法匹配与 `field_boost` 在此处生效）。种子环节的 RRF 与 Host 层的 RRF 是两次独立调用：前者融**实体**，后者融 **chunk**，互不投票、不混粒度。
2. **回退补位（fallback stage，换引擎）**：Host 排序结构不变——图命中占前排，空缺由 chunk 级向量臂 + ES 词法臂 RRF 补位；图臂整体空手（含种子融合后仍无种子）时整列表为向量+词法 RRF。向量臂实现、`rrfFuse`、graph-priority 契约全部不动，只换词法这一路的引擎。

## Boundaries

- **Does:**
  - 新增 Elasticsearch 8.x 精度层模块（新依赖 `@elastic/elasticsearch`），索引期与查询期同源分析器：索引期 `ik_max_word`、查询期 `ik_smart`（analysis-ik 插件）。
  - ES 索引作为**派生索引**：权威数据仍在 Postgres；索引可随时删除重灌；写入链路双写（Postgres 成功后写 ES，沿用 `(source_ref, contentIdentity)` 幂等键语义）。**实体索引**同理：`entities`（canonical_name）与别名表从 Postgres 投影到 ES 实体索引，供种子定位的词法路查询；实体更新/合并（supersession）时同步刷新，重灌命令在 runbook 中与 chunk 索引并列。
  - 排序承载真 Okapi BM25（k1 / b 可调，进 `RetrieveConfig`），短语查询（`match_phrase`）与字段加权（多字段 `boost`）参与排序。
  - 现有 Postgres 词法臂整体摘除：`content_tsv` 生成列、`ts_rank_cd` 排序、`LEXICAL_TSQUERY` 删除（schema 迁移）。
  - dev/test 内存后端保留，`tokenize()` 接入 `Intl.Segmenter`（CJK 词典切词），使测试替身与精度层切词行为对齐；它是测试形态，不违反单一词法实现约定。
  - 降级语义（两处落点各有定义）：ES unconfigured → 词法臂 loud-skip，不设 degraded，种子定位退回纯向量、Host 退回向量单臂（既有行为）；configured-but-failing at call time → 图臂 fail-open（种子退化纯向量继续走图），`degraded=true` 并在 `degraded_reasons` 命名条目；Host 层词法缺席同样命名条目。ES 写失败不阻断 Postgres 权威写入，该 chunk 记 degraded 待重灌。
  - `ARM_CAPABILITY` 映射补齐（`src/core/retrieval/index.ts:173`）：`cjk_segmentation` / `phrase` / `field_boost` 三键进入降级信封可观察集，避免降级漏报。
  - 能力键沿用 `CAPABILITY_REGISTRY` 枚举：`cjk_segmentation`、`keyword_bm25`、`phrase`、`field_boost` 可独立开关并纳入消融矩阵配置。
  - 词法能力在两个阶段接线的落点：实体种子定位（向量路 + 词法路候选 RRF 融合出种子，词法路查 ES 实体索引）与回退补位（现有 RRF 路径换 ES 数据源）。
  - **归档纪律**：被摘除的词法实现、被 supersede 的 spec 正文、替换下来的 runbook，一律移动到 `docs/archive/` 归档，不在源代码仓库里直接删除。
- **Confirms with human:**
  - ES 部署形态（单机 docker / 集群）与 analysis-ik 插件安装方式——实施前确认一次。
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
10. **种子定位融合**：种子环节向量路与词法路候选经 RRF 融合后产出种子列表；固定 fixture 上，词法路关闭时（ES unconfigured 或 `keyword_bm25` off）种子列表与现有纯向量行为一致；专名查询（字面明确、embedding 邻域嘈杂）在融合后种子命中率不低于纯向量。集成测试覆盖三态（两路 / 仅向量 / 词法失败 fail-open）。

## Testing Strategy

五类边界测试分配（对齐 `specs/retrieval-stack.md` §Testing Strategy，映射到新键）：

| Boundary class | 本 spec 覆盖                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| empty          | 空查询 / 空索引（ES 无文档）/ 种子融合两路皆空 → 图臂走 empty-not-degraded 既有语义；`phrase` 空字符串 loud-skip。单测。                 |
| negative       | k1 / b 非法值（≤0）→ typed `ConfigError`；`field_boost` 非法权重 → 配置校验拒绝。单测。                                                  |
| overflow       | 超长中文查询（多 MB 文本）/ 批量重灌（>10k chunks）/ 候选超 `candidateCap` 截断。集成测试。                                              |
| concurrent     | 三臂并行中新 ES 臂的并发查询；双写并发（多 push 同 key）；重灌期间读请求。集成测试。                                                     |
| exception      | ES 不可达（configured-but-failing）→ degraded 命名条目；ES 写失败 → 不阻断权威写入；unconfigured → loud-skip。集成测试覆盖两态（SC-5）。 |

ES 集成测试以 docker ES 服务为前提，未运行时显式 skip 并记录原因（沿用既有集成测试标记模式）。

## Open Questions

(none) — 种子定位已由 operator 升级决策为"词法经 RRF 参与种子定位"（Objective 第 1 条）；ES 部署形态与插件安装方式移入 Confirms with human，实施前确认。

## Inherits / Changes

- **Inherits**：`specs/retrieval-stack.md` 定档 B 与 C-1/C-11 改判；`docs/CONTEXT.md` 已有 **BM25**、**precision layer**、**hybrid retrieval**、**degraded=true**、**RRF fusion (k=60)** 词条（本 spec 引用其定义，不另立）；`specs/retrieve-graph-priority.md` 的 Host 排序契约；`(source_ref, contentIdentity)` 幂等键；四规则 degraded 语义（§B3）；能力键枚举（`src/core/retrieval/types.ts` `CAPABILITY_REGISTRY`）；`GraphragEnv` 配置加载模式（`src/config.ts`，process.env > `.env.local`）；测试命令 `npm test`（vitest）。
- **Changes**：
  - 生产词法载体：Postgres FTS → Elasticsearch 精度层（`content_tsv` / `ts_rank_cd` / `LEXICAL_TSQUERY` 摘除，schema 迁移一份）。
  - `RetrieveConfig` 扩展：`k1`、`b`、phrase / field_boost 开关；`GraphragEnv` 增 ES 连接配置（`GRAPHRAG_MEMORY_ES_*`，凭据仅经 env，不入库不入码）。
  - 能力键 `cjk_segmentation` 从"有键无实现"变为有实现；消融矩阵配置集扩容。
  - 种子定位升级：`seedEntitiesByEmbedding` 纯向量 → 向量路 + ES 词法路候选 RRF 融合（`seed` 接口签名保持，内部两路融合）。
  - `docs/CONTEXT.md` **precision layer** 词条 "entity-finding stage + fallback stage" 表述与代码一致化（本 spec 落地后该表述即真实）。
  - 新增 runbook：ES 索引（chunk + entity）建立与重灌步骤。

## architecture-change-reviewer

- bounded-context-guardian: yes — 精度层是独立模块（词法能力单一职责），经既有 arm 接口接入，无反向依赖；Postgres 仍为权威源，方向不变。
- defensive-contract-validator: yes — 降级两态、unconfigured/failed/empty 三分、幂等双写、开关边界均有验收条目与测试计划。
- error-handling-enforcer: yes — configured-but-failing → degraded 命名条目；unconfigured → loud-skip；双写失败路径（ES 写失败不阻断权威写入，记 degraded）纳入边界。
- complexity-anti-drift: yes — 摘除旧词法臂使排序实现单一化；无第二套口径；新增配置项最少集。
- minimal-change-verifier: yes — 向量/图/RRF/rerank 不动；diff 限定在词法臂载体、配置扩展、归档移动；1 commit = 1 逻辑步交付。
