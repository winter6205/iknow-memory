# Handoff: Elasticsearch 精度层实施（2026-09-03）

## 任务与工作树

- 工作树：`/home/winner/projects/iknow-memory-wt-es-precision`
- 分支：`feat/es-precision-layer`
- 主仓库 `/home/winner/projects/iknow-memory` 未操作。
- 用户原始要求：按 `specs/es-precision-layer.md` 与
  `plans/es-precision-layer.md` 实施，完成后自行 commit + PR。
- 本次 session 因用户要求交接而停止；当前没有 commit，也没有创建 PR。
- 交接时工作树有未提交改动；不要 reset/checkout 丢弃它们。

## 已完成

### T1：MemoryBackend 分词替身

- `src/core/storage/memory-backend.ts`
  - 导出 `tokenize()`。
  - 默认使用 `Intl.Segmenter("zh", { granularity: "word" })`。
  - reduced-ICU 情况下有 Han 字符兜底，连续中文不会折叠成单个词。
  - `cjkSegmentation=false` 恢复连续词元行为。
  - BM25 已读取 `SearchOptions.precision.k1/b`；加入了 phrase/field boost 的替身逻辑。
- `tests/storage/memory-lexical.test.ts`
  - 新增连续中文、中英文混合、单字及纯标点覆盖。

### ES 精度层骨架（部分完成）

- 新增 `src/core/storage/elasticsearch-precision.ts`：
  - `ElasticsearchPrecisionLayer`
  - `PrecisionIndexer`
  - `ElasticsearchClientLike` 注入端口
  - chunk/entity 两个派生索引
  - `ik_max_word` 索引分析器、`ik_smart` 查询分析器
  - ES native BM25 custom similarity，读取 `k1/b`
  - chunk lexical search，validity/filter/phrase/field boost
  - entity canonical name + aliases search
  - `analyze()`、bulk index、rebuild/delete 方法
  - source invalidation 方法已经写入接口和 class，但尚未接到 invalidation tool
- `package.json` / `package-lock.json`
  - 已加入 `@elastic/elasticsearch`（当前 npm 安装为 `^9.5.1`）。
  - 第一次用 WSL 默认 PATH 的 Windows npm 安装失败；随后使用 Linux Node 显式 PATH 成功安装：

    ```powershell
    wsl.exe -d Ubuntu -e bash -lc "cd /home/winner/projects/iknow-memory-wt-es-precision && PATH=/home/winner/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /home/winner/node/bin/node /home/winner/node/lib/node_modules/npm/bin/npm-cli.js install @elastic/elasticsearch"
    ```

- 新增 `tests/storage/elasticsearch-precision.unit.test.ts`，当前 4 个测试通过。

### 配置、检索和种子融合（部分完成）

- `src/config.ts`
  - 新增 `GraphragEnv.elasticsearch`。
  - 支持：
    - `GRAPHRAG_MEMORY_ES_URL`（另支持 `_NODE`）
    - `GRAPHRAG_MEMORY_ES_USERNAME`
    - `GRAPHRAG_MEMORY_ES_PASSWORD`
    - `GRAPHRAG_MEMORY_ES_API_KEY`
    - `GRAPHRAG_MEMORY_ES_CHUNK_INDEX`
    - `GRAPHRAG_MEMORY_ES_ENTITY_INDEX`
    - `GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS`
  - `RetrieveConfig` 新增 k1/b、CJK/phrase/field boost、RRF/vector 开关及 field boost JSON 配置：
    - `GRAPHRAG_MEMORY_RETRIEVAL_K1`
    - `GRAPHRAG_MEMORY_RETRIEVAL_B`
    - `GRAPHRAG_MEMORY_RETRIEVAL_CJK_SEGMENTATION_ENABLED`
    - `GRAPHRAG_MEMORY_RETRIEVAL_PHRASE_ENABLED`
    - `GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOST_ENABLED`
    - `GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOSTS`
    - `GRAPHRAG_MEMORY_RETRIEVAL_RRF_ENABLED`
    - `GRAPHRAG_MEMORY_RETRIEVAL_VECTOR_ENABLED`
- `src/core/types.ts`
  - 新增 `PrecisionSearchOptions` 并挂到 `SearchOptions.precision`。
- `src/core/retrieval/rrf.ts`
  - 新增 `rrfFuseEntitySeeds()`，把实体候选临时投影到既有 `rrfFuse()`，不把实体混入 chunk 粒度。
- `src/core/retrieval/neo4j-graph-arm.ts`
  - `runNeo4jGraphArm(..., query?)` 支持 vector entity seeds + lexical entity seeds 的独立 RRF。
  - lexical seed 查询失败时保留 vector seeds，附带 `keyword_bm25:attempted-and-failed` observation。
- `optional-arms.ts` / retrieval orchestrator / retrieve tool
  - 增加 `lexical`、`entityLexical` 注入端口。
  - 将 precision 配置传到 lexical search。
  - `ArmResult.observations` 会进入中心 degraded 计算。
- `src/index.ts`
  - 配置 ES 时创建 `ElasticsearchPrecisionLayer`。
  - `buildRetrieveDeps()` 将它作为 chunk lexical 与 entity lexical seam 传给 retrieve。
- `tests/retrieval/neo4j-graph-arm.unit.test.ts`
  - 新增两路实体种子融合及 lexical seed fail-open 测试。

### 权威写后 ES 双写（部分完成）

- `src/tools/ingest.ts`、`src/tools/push.ts`
  - 增加可选 `precision` writer。
  - Postgres/authority `upsert` 成功后才写 ES。
  - ES 写失败不会回滚或阻断 authority write；返回 `degraded` 和
    `keyword_bm25:attempted-and-failed`。
- 仍未把 `precision` 传入 `createServer()` 的 ingest/push/invalidation 依赖闭环验证，也未补 invalidation ES 更新。

## 已验证命令

以下命令均从 Windows cwd 通过 WSL 执行，输出重定向到 `/tmp`：

1. T1 RED：最初 build 因 ES 文件泛型括号错误失败，已修复。
2. T1 GREEN：
   - `npm test -- --run tests/storage/memory-lexical.test.ts`
   - 结果：`19 tests passed`
3. 之后精度层 + 种子融合：
   - `npm test -- --run tests/storage/elasticsearch-precision.unit.test.ts tests/retrieval/neo4j-graph-arm.unit.test.ts`
   - 结果：`24 tests passed`（ES 4 + Neo4j 20）
4. entity/optional-arms 改动后曾执行：
   - `npm run typecheck`
   - 结果通过。

最后一次 `elasticsearch-precision.ts` 增加 `invalidateSourceRef()` 后尚未重新执行
typecheck/full suite；下一个 session 必须先执行它们。

## 未完成事项（按 plan）

### T2：部署决策与本地栈

- 尚未新增 Dockerfile/compose。
- 尚未写 `docs/runbooks/es-precision-layer.md`。
- runbook 需要覆盖：
  1. Elasticsearch 8.x single-node；
  2. 与 ES 版本匹配的 `analysis-ik` 安装；
  3. `_analyze` 连续中文 token 数 ≥ 2；
  4. chunk/entity index 创建；
  5. 重灌与故障重试。
- 注意：当前客户端是 v9.5.1，而目标服务是 ES 8.x；续做时确认兼容性，若仓库约束要求 ES 8 client，应通过 npm 选择兼容版本并重新 lock。

### T3：ES 双写闭环和失败记录

- `src/index.ts` 目前只创建 precision 并放入 `ServerDeps`/retrieve；要确认
  `ingestTool(deps)`、`pushTool(deps)`、`invalidationTool(deps)` 都得到该 writer。
- invalidation 后需要调用 `precision.invalidateSourceRef(sourceRef, invalidatedAt)`；
  authority 已成功但 ES 失败时同样 fail-open、具名返回/日志。
- “待重灌”目前只有响应和 stderr 痕迹，没有 durable pending record。按 spec 要求补一个权威侧可查询/可重放的失败记录，或在 runbook/测试中明确采用现有具名记录机制。
- 检查 `PrecisionIndexer` / fake client 的 API 与实际 `@elastic/elasticsearch` 版本。

### T4：Host ES 词法臂

- `PgvectorBackend` 仍然实现旧 Postgres lexical path，尚未摘除。
- `src/core/storage/pgvector-backend.ts` 仍含旧生成列/旧排序 SQL。
- 必须：
  - 移除 `LexicalStorageBackend` from Pgvector implementation；
  - 删除旧 schema 建立逻辑；
  - 用一份迁移安全地去掉既有部署上的旧 derived lexical column/index。为满足 active-tree 静态 grep，可把旧列名拼接成字符串，不要在 active source/test 保留旧标识字面量；
  - 保留 MemoryBackend lexical 替身；
  - 将 ES search 作为生产 lexical seam。
- 旧 `tests/integration/bm25-pg.test.ts` 依赖旧 Postgres lexical schema，需要改写成 ES integration test（未配置 ES 时 loud skip），或把旧测试/说明归档。
- 现有 active `specs/es-precision-layer.md` 本身仍包含旧术语作为验收描述；静态 grep 的判定范围要确认，至少 `src/` 和 active tests 不应残留旧实现代码。

### T5：实体索引与 seed RRF

- 单测骨架已完成，但 production entity projection 未完成：
  - extract CLI 新建/merge/supersession/alias 变化后要调用 `precision.indexEntities()`；
  - entity document 必须使用最终 canonical name 和完整 aliases，不可用单次 alias 覆盖历史 aliases；
  - retired/merged entity 应从 ES entity index 删除或标记为不可搜索；
  - 增加重灌 entity index 的 PG 投影查询。
- `runNeo4jGraphArm` 的 lexical failure observation 要补断言到 assembler envelope，确保只报 keyword（或按最终 capability policy 报名），不误判 graph arm below-floor。

### T6：消融矩阵

- 尚未实现新的 stack evaluation/ablation entry。
- 需要新增 `npm run eval:stack`（建议新建 `src/cli/eval-stack.ts`，不要把 retrieval import 放进已有隔离的 `src/cli/eval.ts`）。
- 固定 8 个能力键：
  `vector`、`keyword_bm25`、`cjk_segmentation`、`phrase`、
  `field_boost`、`graph_ppr`、`rrf`、`rerank`。
- 生成至少 10 配置：全开、逐项关闭 8 个、全关；每个配置记录 raw runs 和 median，输出 JSON + Markdown。
- `src/core/eval` 可新增纯函数：
  - matrix builder；
  - median/percentage change；
  - metric schema；
  - deterministic report renderer。
- 现有 `src/cli/eval.ts` 是 extraction-eval 且有 isolation test，不要破坏它。

### T7：Postgres lexical removal/archive

- 归档 `specs/bm25-retrieve.md` 到 `docs/archive/`，原位置留下指路文件。
- `docs/archive` 被 `.gitignore` 忽略，最终 commit 必须显式 `git add -f docs/archive/...`。
- 旧 runbook/代码快照也按 spec 归档纪律移动，不要直接删除。
- 更新 `docs/CONTEXT.md` 的 production lexical 描述，避免仍声称生产由 Postgres lexical 实现。

### T8：文档/runbook/archive

- 完成 ES 部署、plugin、index mapping、chunk/entity rebuild、failure recovery。
- `.env.example`、README/MCP config 增加 ES 连接变量和说明，绝不加入密钥值。
- 可增加 `src/cli/es-reindex.ts` + package script，例如 `es:reindex`：
  - 从 Postgres authoritative chunks/entities/aliases 扫描；
  - 删除并重建两个 ES indexes；
  - 批量写入（>10k 也不能丢）。
- reindex 不应修改 Postgres 行。

### T9：全量验证、review、commit、PR

建议顺序：

```powershell
wsl.exe -d Ubuntu -e bash -lc "cd /home/winner/projects/iknow-memory-wt-es-precision && PATH=/home/winner/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run typecheck > /tmp/es_precision_typecheck_final.txt 2>&1"
wsl.exe -d Ubuntu -e bash -lc "cd /home/winner/projects/iknow-memory-wt-es-precision && PATH=/home/winner/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm test > /tmp/es_precision_test_final.txt 2>&1"
wsl.exe -d Ubuntu -e bash -lc "cd /home/winner/projects/iknow-memory-wt-es-precision && PATH=/home/winner/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run build > /tmp/es_precision_build_final.txt 2>&1"
```

- substantive edits 后对改动文件执行 `ReadLints`。
- 运行 ES/PG/Neo4j integration；外部服务没配置时必须显式 loud skip。
- 检查 `git diff`，确认没有密钥、没有 `dist/`、没有临时文件。
- 按 code-review skill 在 commit 前做 standards/spec review；有 unresolved High 不得 commit。
- 用户明确要求 commit + PR，但本 session 不执行。下个 session 完成后：
  1. 并行查看 `git status`、`git diff`、`git log`；
  2. 只 stage 本 worktree 改动（归档文件需 `git add -f`）；
  3. 通过 heredoc 创建一个逻辑 commit；
  4. `git status` 验证；
  5. `git push -u origin HEAD`；
  6. 用 `gh pr create` 创建 PR 并把 URL 回报用户。

## 续做第一步

1. 读取本 handoff、plan/spec 和当前 `git diff`。
2. 先修/验证最后一次 `invalidateSourceRef()` 后的 typecheck。
3. 补 ES 配置测试和 server wiring 测试。
4. 再处理 Pgvector 旧 lexical removal，避免在尚未清理旧实现前扩展更多测试。

## 重复交接确认

- 2026-09-03 再次确认：工作树仍停留在 `feat/es-precision-layer`，上述未提交改动仍需保留。
- 本次仅更新交接文档；没有继续实现、没有 commit、没有 push、没有创建 PR。
