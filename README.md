# iknow-memory

外置记忆 MCP 服务。

## 定位

- **外置记忆服务**：通过 MCP（Model Context Protocol）接入任何智能体 host
- **host-agnostic**：不依赖任何特定 host（iknow / Claude Code / 自定义 agent 均可接入）
- **不做上下文工程**：JIT retrieval / cache 布局 / 上下文组装是 host 的事，server 只负责"存得对、查得准、可时间切片"
- **自洽定位**：以混合检索、分层记忆与 bi-temporal 时间模型为基础能力；以 LLM 三元组抽取、canonical 实体合并、PPR 多跳、社区检测为迭代方向（不绑任何外部学习对象）

## 当前状态

- **已在 main**：Stage 0+1 ingest/retrieve；P0 抽取/合并；vector + BM25；Neo4j PPR 图臂；graph-priority；ES 精度层；质量栈 T1–T11；MCP 五件套 `ingest` / `push` / `invalidate` / `extract` / `retrieve`；图/精排/ES fail-start（ADR-0006 / ADR-0007）。
- **精排**：默认走 MiniMax LLM（Anthropic 兼容 HTTP）。`GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL` 是可选的本地/专用 rerank sidecar，不是 MiniMax 那条。
- **进行中**：`plans/retrieval-stack.md` T17–T24（自检 / 重灌 / 评测收口）。侧线 vitest flake [#170](https://github.com/winter6205/iknow-memory/issues/170)。
- **后置**：多粒度切分、Neo4j 节点 embedding。进度以 `plans/` + `specs/` + `docs/CONTEXT.md` 为准（`docs/handoff/` 本地会话笔记，不入库）。

## Elasticsearch 精度层（默认开启）

`GRAPHRAG_MEMORY_ES_URL` 是精度层的**地址**，不是 feature switch。默认开启的精度层缺地址时 `loadEnv()` 抛 `ConfigError` 拒绝启动（ADR-0007 fail-start）——和 graph / rerank 缺依赖同形。只有显式 `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false` 才能在无 ES 地址时启动（测试/逃生门，不是产品故事）。已配置但调用期失败的 ES 仍 fail-open：向量结果照常返回并置 `degraded`。

设置后启用四项词法能力（中文分词 + Okapi BM25 + 短语 + 字段加权），同一引擎同一词元流承载：

- **chunk / entity 双写**：`ingest`、`push` 写入 Postgres 成功后再写两份派生索引
  `iknow-memory-chunks` 与 `iknow-memory-entities`（索引与 mapping 由
  `src/core/storage/elasticsearch-precision.ts` 的 `chunkMappings()` / `entityMappings()` 定义，首次写入时自动建索引）。
- **两路词法召回**：Host 排序的 fallback + remainder fill 接 ES 词法臂，
  Neo4j 图臂种子由向量路 + ES 词法路 RRF 融合产生（同一 RRF 常数 k=60，两次独立调用）。
- **降级语义**：`unconfigured` → 缺地址拒绝启动（ADR-0007 fail-start，见上）；
  `configured-but-failing at call time` → 词法臂填命名条目（`keyword_bm25` 等），
  向量结果照常返回。

部署、版本对齐（ES 8.x / analysis-ik 同 patch / `@elastic/elasticsearch` 8.x）、
安装、映射、重灌与重写恢复详见 [`docs/runbooks/es-precision-layer.md`](docs/runbooks/es-precision-layer.md)。
环境变量见 `.env.example` 末尾“Elasticsearch precision layer”块。

## 运行

```bash
npm install
npm run build
npm start          # stdio MCP server
```

开发模式：

```bash
npm run dev        # tsx src/index.ts
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## MCP 注册

在 host 的 MCP JSON（例如 `.mcp.json` 或 `.cursor/mcp.json`）中注册。
Host JSON 的 `env` 是 MCP 用户配置的 SSOT；`.env.local` 仅作本地开发 fallback。
完整说明见 [`docs/mcp-config.md`](docs/mcp-config.md)。

```json
{
  "mcpServers": {
    "iknow-memory": {
      "command": "node",
      "args": ["path/to/iknow-memory/dist/index.js"],
      "env": {
        "GRAPHRAG_MEMORY_STORAGE": "pgvector",
        "GRAPHRAG_MEMORY_DB_URL": "postgresql://iknow_memory:<db-password>@localhost:5432/iknow_memory",
        "GRAPHRAG_MEMORY_NEO4J_URI": "bolt://localhost:7687",
        "GRAPHRAG_MEMORY_EMBED_API_KEY": "<embedding-api-key>",
        "GRAPHRAG_MEMORY_EMBED_BASE_URL": "https://open.bigmodel.cn/api/paas/v4",
        "GRAPHRAG_MEMORY_EMBED_MODEL": "embedding-3",
        "GRAPHRAG_MEMORY_EMBED_DIMENSIONS": "1536",
        "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS": "2000",
        "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED": "true",
        "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV": "MINIMAX_API_KEY",
        "MINIMAX_API_KEY": "<minimax-api-key>",
        "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "GRAPHRAG_MEMORY_ANTHROPIC_MODEL": "MiniMax-M3",
        "GRAPHRAG_MEMORY_ES_URL": "http://localhost:9200",
        "GRAPHRAG_MEMORY_ES_CHUNK_INDEX": "",
        "GRAPHRAG_MEMORY_ES_ENTITY_INDEX": "",
        "GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS": "5000"
      }
    }
  }
}
```

rerank 默认开启，走 MiniMax LLM。也可设 `ANTHROPIC_AUTH_TOKEN`；若同时设了
`GRAPHRAG_MEMORY_RERANK_API_KEY_ENV`，以指针指向的密钥为准。
`GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL` 留给专用 rerank sidecar（例如本机
`http://localhost:8080/rerank`）。本机 pgvector HNSW 索引上限 2000 维，
`GRAPHRAG_MEMORY_EMBED_DIMENSIONS` 必须 ≤ 该上限（不要用 2048）。
Neo4j sidecar：`bash scripts/neo4j.sh start`。

Embedding 与 secret 放置规则见 [`docs/mcp-config.md`](docs/mcp-config.md)。

## MCP Tools

| Tool         | 输入                                                          | 输出                        | 说明                                   |
| ------------ | ------------------------------------------------------------- | --------------------------- | -------------------------------------- |
| `ingest`     | `{content, source_ref, metadata?, valid_from?, valid_until?}` | `{chunk_ids}`               | 写入：原样落库 → embed → store         |
| `push`       | 与 ingest 相同的内容写入契约                                  | `{chunk_ids}`               | 写入（fin/host 推送入口）              |
| `invalidate` | `{source_ref, triggered_by, invalidated_at?}`                 | `{invalidated_chunk_ids,…}` | 关闭有效窗口，不物理删除               |
| `extract`    | `{chunk_ids}` xor `{source_ref}`                              | 抽取计数 / 失败列表         | 三元组抽取（与 CLI 同一管线）          |
| `retrieve`   | `{query, valid_at?, filters?, limit?}`                        | `{chunks[]}`                | 图优先 + 向量/词法 + 可选 MiniMax 精排 |

## 项目结构

```
src/
  index.ts              # MCP server 入口（stdio transport）
  config.ts             # 环境变量解析（SSOT）
  logging.ts            # stderr 结构化日志
  core/
    types.ts            # 领域类型（ChunkRecord / StorageBackend / SearchOptions）
    chunker.ts          # 定长滑动窗口分块
    cosine.ts           # cosine similarity
    embedder.ts         # 嵌入客户端（NineRouterEmbedder / FakeEmbedder）
    errors.ts           # 错误分类（GraphragError + error codes）
    storage/
      backend.ts        # StorageBackend 接口
      memory-backend.ts # 内存后端（dev/test）
      pgvector-backend.ts # pgvector 后端（生产）
  tools/
    registry.ts         # tool 注册契约
    echo.ts             # echo tool
    ingest.ts           # ingest tool handler
    retrieve.ts         # retrieve tool handler
tests/                  # vitest 测试
docs/
  CONTEXT.md            # 领域词汇表（SSOT）
```

## 路线

详见 `docs/CONTEXT.md` 词汇表与各份 ADR/spec 的自我说明。

## iknow-memory dashboard（只读操作看板）

本仓库内的只读 HTTP API（`src/dashboard-api`）+ React SPA（`dashboard/`）。绑定 `127.0.0.1`。不要合入已关的 PR 187。规格见 `specs/iknow-memory-dashboard.md`。

一条命令同时起 API 与 SPA（推荐）：

```bash
npm run dashboard
```

根目录 `npm install` 不会装上 `dashboard/` 的依赖。`npm run dashboard` 发现缺 Vite 时会自动执行 `npm install --prefix dashboard`；只有自动安装失败才需要你手动跑同一条命令。

浏览器打开 `http://127.0.0.1:18868/`。端口：

| 进程        | 默认              | 说明                                                    |
| ----------- | ----------------- | ------------------------------------------------------- |
| SPA（Vite） | `127.0.0.1:18868` | 不是 5173；`/api` 代理到 API                            |
| API         | `127.0.0.1:4174`  | `GRAPHRAG_MEMORY_DASHBOARD_PORT` 可覆盖，且不得为 18868 |

`Ctrl-C`（或任一侧退出）会结束整棵进程树，释放 18868 与 4174。

也可以分开跑：

```bash
npm run dashboard-api    # src/dashboard-api/main.ts，默认 127.0.0.1:4174
npm run dashboard:dev    # dashboard Vite，18868，/api → 4174
```

**存储：** 未设置 `GRAPHRAG_MEMORY_STORAGE` / `GRAPHRAG_MEMORY_DB_URL` / `GRAPHRAG_MEMORY_NEO4J_URI` 时，`npm run dashboard` 自动用 memory 后端（空库、无外部依赖），并关闭图臂、精排与 ES 精度层（`GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED=false`、`GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED=false`、`GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false`），避免 ADR-0006 / ADR-0007 fail-start。设置了任一项则原样透传 MCP 那套 `GRAPHRAG_MEMORY_*`。

**memory vs pg：** memory 可看 stats / query / browse / timeline（空库为空态）。`GRAPHRAG_MEMORY_STORAGE=pgvector` 且配置 `GRAPHRAG_MEMORY_DB_URL` 时读 Postgres。

**Neo4j：** 可选。未配置或不可达时图页返回结构化错误，不是空图。配置 `GRAPHRAG_MEMORY_NEO4J_URI`（及既有 Neo4j 凭据）后图投影可读。`GET /api/entities/:id/backlinks`（邻域页）同样：缺 Neo4j 是错误+重试，不是空态。

**Vite `/api` 代理：** 与 API 同一环境变量 `GRAPHRAG_MEMORY_DASHBOARD_PORT`（默认 4174）。`npm run dashboard` 会把解析后的端口写入子进程 env，Vite 按该端口转发。

### SC6 浏览器核对（operator checklist）

在 `npm run dashboard` 起来后打开 `http://127.0.0.1:18868/`：

1. **冷墨默认：** 底色近 `#0e1218`、字近 `#e8e4d9`；页头字标 `iknow-memory`。
2. **晨纸切换：** 打开页头「晨纸」开关，底色近 `#f3f1ea`、字近 `#1c1e22`；再关回冷墨。
3. **空态页（至少一页）：** memory 空账本下「统计」或「浏览」显示空态文案，不是错误条。
4. **能力缺口：** 「图谱」以及 entity「邻域」在未配置 Neo4j 时显示 `NEO4J_UNAVAILABLE` +「重试」，不是空图。

未加 Playwright（栈里没有）。2026-09-09 实测（memory 零配置，`curl` 经 18868 代理）：

| 命令                                                                                          | 结果                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18868/`                             | `200`                                                 |
| `curl -sS http://127.0.0.1:18868/api/stats`                                                   | `200` `{"chunks":0,"entities":0,"invalidations":0}`   |
| `curl -sS http://127.0.0.1:18868/api/chunks`                                                  | `200` 空 page                                         |
| `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18868/browse`                       | `200`（SPA）                                          |
| `curl -sS http://127.0.0.1:18868/api/graph`                                                   | `503` `NEO4J_UNAVAILABLE`                             |
| `curl -sS http://127.0.0.1:18868/api/entities/11111111-1111-1111-1111-111111111111/backlinks` | `503` `NEO4J_UNAVAILABLE`                             |
| `curl -sS http://127.0.0.1:18868/src/index.css`                                               | 含冷墨 `#0e1218`/`#e8e4d9` 与晨纸 `#f3f1ea`/`#1c1e22` |

晨纸开关是客户端 CSS 变量（`document.documentElement` `data-theme`）；`curl` 不能点开关。主题默认与切换由 `dashboard/src/spa-shell.test.ts` 覆盖。

## 约束

- TS strict ESM · Node ≥20 · Vitest
- 不依赖 iknow runtime（zero import from iknow `src/`）
- 不引入任何外部项目源码 / 二进制作运行时依赖；本地若存有上游参考目录，仅作离线对照，禁止 runtime 链接 / import / symlink / 动态加载
- env 名不写明文（API key 通过 `*_API_KEY_ENV` 间接寻址）
