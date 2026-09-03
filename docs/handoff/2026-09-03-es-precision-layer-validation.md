# T9 端到端验收记录 — ES 精度层（specs/es-precision-layer.md SC-1–SC-10）

> 日期：2026-09-03。分支 `feat/es-precision-layer`（worktree
> `/home/winner/projects/iknow-memory-wt-es-precision`）。逐条记录
> `specs/es-precision-layer.md` Success Criteria 1–10 的验证状态、命令与实际结果。
> 依赖外部服务（ES / PG / Neo4j）的条目标 `not-run` 并附 Validation 块。

## 结果总览

| SC  | 条目                                    | Status                                 |
| --- | --------------------------------------- | -------------------------------------- |
| 1   | 中文词法召回（cjk_segmentation 开关）   | not-run（部分证据见下）                |
| 2   | 词元断言（分析接口 ≥ 2 token）          | not-run（替身侧已验证）                |
| 3   | 真 BM25，k1/b 生效                      | not-run（单测已锁语义）                |
| 4   | 短语与字段加权                          | not-run（phrase 集成条目同属 ES 套件） |
| 5   | 降级语义（unconfigured / failing 两态） | pass（单测）                           |
| 6   | 单一实现（PG 词法残留 grep 为零）       | pass                                   |
| 7   | 消融矩阵                                | pass（端到端实测）                     |
| 8   | 归档完整                                | pass                                   |
| 9   | 测试替身对齐                            | pass                                   |
| 10  | 种子定位融合（三态）                    | pass（单测）                           |

全量门禁（本轮实测，2026-09-03）：

```
npm run typecheck  → exit 0
npm test           → Tests 1388 passed | 14 skipped (1402), 0 failed
npm run build      → exit 0
```

---

## SC-1 中文词法召回

**Status: not-run（核心断言依赖真实 ES + analysis-ik）**

真实 ES 环境不可用，`npm run eval:stack -- --single zh-segment-off` 需要在
ES 精度层上跑（当前 eval:stack 离线形态基于 MemoryBackend 替身，其
`off-cjk_segmentation` 行 ΔP@5 = 0.00%，无法证明 ES 侧 IK 分词行为）。

补充证据（替身侧 + 纯 Node ICU 层）：

- `Intl.Segmenter("zh", {granularity:"word"})` 对「中文分词检索测试」切出
  4 个词元（中文|分词|检索|测试）——`node -e` 实测。
- `tests/storage/memory-lexical.test.ts`（19 tests，pass）覆盖连续中文 /
  中英混合 / 单字 / 纯标点。
- `tests/integration/bm25-pg.test.ts`「indexes Chinese chunks and retrieves
  them on a Chinese query」是本条的真实 ES 断言载体（见 not-run 块）。

```text
Validation:
- Not run: npm run eval:stack -- --single zh-segment-off（ES 侧）；
  npx vitest run tests/integration/bm25-pg.test.ts（整文件 skip 路径下未执行用例体）
- Expected command: GRAPHRAG_MEMORY_ES_URL=<es8-with-analysis-ik> npm run eval:stack -- --single zh-segment-off
- Blocking issue: 本机无 Elasticsearch 8.x 服务（未装 analysis-ik 插件）
```

## SC-2 词元断言（分析接口 ≥ 2 token）

**Status: not-run（`_analyze` 需要真实 ES 集群）**

替身侧证据：MemoryBackend `tokenize()`（`Intl.Segmenter`）对连续中文返回
≥ 2 词元，见 SC-1 的 node 实测与 `tests/storage/memory-lexical.test.ts`
"segments continuous Chinese text into multiple lexical terms"（pass）。
ES 侧载体：`ElasticsearchPrecisionLayer.analyze()` 走
`ik_query` analyzer，单测
`tests/storage/elasticsearch-precision.unit.test.ts`「analyzes text through
the query analyzer」验证了请求 shape（pass，fake client）。

```text
Validation:
- Not run: curl -fsS -X POST "$GRAPHRAG_MEMORY_ES_URL/_analyze" -H 'Content-Type: application/json' -d '{"analyzer":"ik_smart","text":"<连续中文>"}' 后断言 tokens.length >= 2
- Expected command: 同上（runbook docs/runbooks/es-precision-layer.md §Verifying tokenizer with _analyze）
- Blocking issue: 本机无 Elasticsearch 8.x 服务（_analyze 为集群端点）
```

## SC-3 真 BM25，k1 / b 生效

**Status: not-run（排序对比需要真实集群）；语义口径已单测锁定**

Review High-3 修复后确定的口径：**k1/b 在 ES 侧是索引期参数**
（BM25 similarity settings，`createIndexIfMissing` 建索引时写入；
Elasticsearch 无 per-request BM25 override），查询期通道仅由
MemoryBackend 替身消费（in-memory BM25 逐查询计算）。

本轮新增/改写的证据：

- `tests/storage/elasticsearch-precision.unit.test.ts`（11 tests，pass）：
  - 「creates IK/BM25 mappings…」断言 `indices.create` 的 settings 携带
    `"k1":1.4` / `"b":0.65`；
  - 「ignores query-time k1/b entirely (index-time-only semantics)」：
    `precision: {k1:0.3, b:0.9}` 下的 search 请求体与不带 k1/b 时
    byte-identical——证明查询体不夹带 k1/b（无假通道）。
- `tests/integration/bm25-pg.test.ts`「changing k1 re-creates the index and
  produces a different ordering」已改写为索引期语义：改 k1 →
  `deleteChunkIndex()` → 新 layer `indexChunks()` 重建 → 比较排序。
  该测试属于 ES 集成套件，本机 skip（见 Validation 块）。
- 注释一致化：`elasticsearch-precision.ts searchLexical`、
  `memory-backend.ts searchLexical`、`src/core/types.ts
PrecisionSearchOptions.k1/b` 三处注释同口径（同一旋钮、不同机制）。

```text
Validation:
- Not run: npx vitest run tests/integration/bm25-pg.test.ts（"changing k1 re-creates the index…" 用例体）
- Expected command: GRAPHRAG_MEMORY_ES_URL=<es8-with-analysis-ik> npx vitest run tests/integration/bm25-pg.test.ts
- Blocking issue: 本机无 Elasticsearch 8.x 服务
```

## SC-4 短语与字段加权

**Status: not-run（ES 集成用例 skip）；替身侧 pass**

- `tests/integration/bm25-pg.test.ts`「phrase switch produces a different
  ranking than phrase-off」为真实 ES 断言载体（skip，见下）。
- `tests/storage/elasticsearch-precision.unit.test.ts`「uses phrase and
  field boosts in the lexical query and maps hits」（pass）验证请求体含
  `match_phrase` / `content^` boost 字段。
- 消融矩阵端到端（SC-7 实测）中 `off-phrase` / `off-field_boost` 行均
  ΔP@5 = 0.00%——离线 MemoryBackend 语料上这两开关无可观测差异，
  差异验证依赖 ES 集成用例。

```text
Validation:
- Not run: npx vitest run tests/integration/bm25-pg.test.ts（"phrase switch…" 用例体）
- Expected command: GRAPHRAG_MEMORY_ES_URL=<es8-with-analysis-ik> npx vitest run tests/integration/bm25-pg.test.ts
- Blocking issue: 本机无 Elasticsearch 8.x 服务
```

## SC-5 降级语义（unconfigured / configured-but-failing 两态）

**Status: pass（单测覆盖两态）**

命令：`npx vitest run tests/retrieval/degraded-envelope.test.ts
tests/retrieval/hybrid-arms.test.ts tests/retrieval/neo4j-graph-arm.unit.test.ts`

实际结果：49 passed。

- unconfigured（loud-skip，不置 degraded）：
  `tests/retrieval/hybrid-arms.test.ts`「preserves plain vector ranking when
  the arm is off」「returns exactly {chunks} when the backend has no lexical
  seam」——词法缺席时返回纯向量、无 degraded。
- configured-but-failing（degraded=true + 命名条目）：
  `tests/retrieval/degraded-envelope.test.ts`「rule 2: names an attempted
  capability that failed」断言 `degraded_reasons` 含
  `keyword_bm25:attempted-and-failed`；「entity lexical fail-open names
  keyword_bm25 only — never graph_ppr」锁定实体词法腿失败不会误报为图臂
  失败。
- 图臂 fail-open：`tests/retrieval/neo4j-graph-arm.unit.test.ts`「keeps
  vector entity seeds when the lexical seed lookup fails」（pass）。
- extract 生产 wiring（本轮 High-2 修复）：
  `tests/cli/extract.unit.test.ts`「runCliFromEnv precision wiring」——
  env 配 ES 时构造 `ElasticsearchPrecisionLayer`（k1/b 来自 env.retrieval）
  并在 finally 中 close；未配置时为 undefined 静默 no-op（2 tests，pass）。

## SC-6 单一实现（PG 词法残留 grep 为零）

**Status: pass**

命令与结果：

```
$ grep -rn "content_tsv\|ts_rank_cd\|LEXICAL_TSQUERY" src/ tests/ --include="*.ts" | grep -v archive | wc -l
0
```

`docs/runbooks/`（active docs）本轮同步清理：
`integration-smoke.md` 的 `GRAPHRAG_MEMORY_STORAGE` 描述已由
「BM25 `content_tsv`」改为「lexical ranking lives in the ES precision layer」，
active docs 无残留字面量。

## SC-7 消融矩阵

**Status: pass（端到端实测）**

命令与结果（离线形态，冻结语料 `eval/corpus/retrieve-v1.json` +
`eval/gold/retrieve-v1.json`，12 查询）：

```
$ GRAPHRAG_MEMORY_EMBED_DIMENSIONS=2048 GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS=2048 \
    node dist/cli/eval-stack.js \
    --gold eval/gold/retrieve-v1.json --corpus eval/corpus/retrieve-v1.json \
    --valid-at 2026-01-02T00:00:00.000Z --out /tmp/eval-stack-t9-fixed
INFO eval-stack-complete {"configs":10,"runsPerConfig":3,"json":"/tmp/eval-stack-t9-fixed.json","md":"/tmp/eval-stack-t9-fixed.md"}
exit 0
```

10 配置 × 3 repeats 全部落盘（JSON + Markdown，byte-stable 由
`tests/cli/eval-stack.unit.test.ts`「writes byte-identical JSON + Markdown on
a second run」保证）。关键行（median P@5，Δ 对 all-on 基线）：

| id                   | median P@5 |    Δ P@5 |
| -------------------- | ---------: | -------: |
| all-on               |       0.10 |    0.00% |
| off-keyword_bm25     |       0.07 |  -30.00% |
| off-cjk_segmentation |       0.10 |    0.00% |
| off-phrase           |       0.10 |    0.00% |
| off-field_boost      |       0.10 |    0.00% |
| all-off              |       0.00 | -100.00% |

说明：本机实测 `off-keyword_bm25` ΔP@5 = -30.00%（0.10 → 0.07）；
此前 session 记录的 -33.33% 为不同语料/权重组合下的结果，以本次
`/tmp/eval-stack-t9-fixed.md` 的可复现输出为准。矩阵含全部新键开关
（`cjk_segmentation` / `phrase` / `field_boost` 单独行 + `keyword_bm25`），
缺配置 = 0、原始值与中位数落盘，符合 `specs/retrieval-stack.md` §B1。
`cjk_segmentation` / `phrase` / `field_boost` 在离线语料上 Δ=0 是预期：
这三个开关的可观测差异验证载体是 ES 集成测试（SC-1 / SC-4）。

## SC-8 归档完整

**Status: pass**

- `docs/archive/` 含三件归档：`bm25-retrieve.md`（被 supersede 的 spec
  正文，头部保留 Archived/Superseded by 指路）、
  `pg-lexical-removal.md`（PG 词法摘除说明）、
  `integration-bm25-pg.test.ts`（旧 PG 词法集成测试）。
- `specs/bm25-retrieve.md` 原位保留为 path-stable pointer，正文指向
  `docs/archive/bm25-retrieve.md` 与 `specs/es-precision-layer.md`。
- 注：`docs/archive/` 曾在 `.gitignore` 忽略名单内，commit 时需
  `git add -f docs/archive/...`（session handoff 已记录）。

## SC-9 测试替身对齐

**Status: pass**

命令：`npx vitest run tests/storage/memory-lexical.test.ts` → 19 passed。
覆盖：连续中文切出多词元、中英混合可检索、单字中文、纯标点输入
（"handles a single Chinese character and punctuation-only input"）。
`Intl.Segmenter` 实测见 SC-1（4 词元）。

## SC-10 种子定位融合（三态）

**Status: pass（单测覆盖三态）**

命令：`npx vitest run tests/retrieval/neo4j-graph-arm.unit.test.ts` → 20 passed。

- 两路融合：「fuses vector and lexical entity candidates before PPR」——
  向量候选与词法候选经 `rrfFuseEntitySeeds` 融合后才进 PPR，seed 接口
  签名不变（`seedEntitiesByEmbedding` 消费点未动）。
- 词法关闭 = 纯向量现状：实体索引 unconfigured / `keyword_bm25` off 时
  词法路不产生候选，融合退化为纯向量序（`runNeo4jGraphArm` 内部对
  lexical 候选为空的处理，由融合测试的空词法分支覆盖）。
- 词法失败 fail-open：「keeps vector entity seeds when the lexical seed
  lookup fails」——保留向量种子继续走图，envelope 记
  `keyword_bm25:attempted-and-failed`（degraded-envelope 测试锁定命名）。

---

## 全量验证（T9 收尾门禁）

```
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
typecheck exit: 0

$ npm test
Test Files  115 passed | 3 skipped (118)
     Tests  1388 passed | 14 skipped (1402)      ← 0 failed

$ npm run build
build exit: 0

$ grep -rn "content_tsv\|ts_rank_cd\|LEXICAL_TSQUERY" src/ tests/ --include="*.ts" | grep -v archive | wc -l
0
```

14 skipped 全部为外部服务依赖（ES / PG / Neo4j 集成套件）的显式
loud-skip 路径，各套件在 skip 时打印带 Expected command 的
Validation 块，与 `docs/.claude/rules/test.md` 的记录规则一致。

## 遗留（超出本 spec 的后续动作）

- SC-1/2/3/4 的 ES 集成断言需在部署了 ES 8.x + analysis-ik 的环境中
  复跑 `tests/integration/bm25-pg.test.ts` 并记录真实输出。
- `off-phrase` / `off-field_boost` 的可观测排序差异（SC-4 消融口径）
  同样依赖真实 ES 语料，当前离线矩阵中为 0.00%（预期，非回归）。
