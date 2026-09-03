# iknow-memory

外置记忆 MCP 服务。

## 定位

- **外置记忆服务**：通过 MCP（Model Context Protocol）接入任何智能体 host
- **host-agnostic**：不依赖任何特定 host（iknow / Claude Code / 自定义 agent 均可接入）
- **不做上下文工程**：JIT retrieval / cache 布局 / 上下文组装是 host 的事，server 只负责"存得对、查得准、可时间切片"
- **自洽定位**：以混合检索、分层记忆与 bi-temporal 时间模型为基础能力；以 LLM 三元组抽取、canonical 实体合并、PPR 多跳、社区检测为迭代方向（不绑任何外部学习对象）

## 当前状态

- **已在 main**：Stage 0+1 ingest/retrieve；P0 抽取/合并 wiring；vector + BM25；Neo4j PPR 图臂；graph-priority 排序；临时 LLM rerank（默认 off）
- **进行中**：检索/图谱质量栈 T2–T11 — `plans/retrieve-graph-quality.md`（tracker 只认仓库文件，不认 GitHub issues）
- **后置**：抽取 F1（#15）、多粒度切分、专用社区/因果等见该 plan 未勾选项

## Elasticsearch 精度层（可选增强）

当 `GRAPHRAG_MEMORY_ES_URL` 未设置时，`retrieve` 行为与现状完全一致（向量单臂，词法臂 loud-skip，`degraded` 不变）。

设置后启用四项词法能力（中文分词 + Okapi BM25 + 短语 + 字段加权），同一引擎同一词元流承载：

- **chunk / entity 双写**：`ingest`、`push` 写入 Postgres 成功后再写两份派生索引
  `iknow-memory-chunks` 与 `iknow-memory-entities`（索引与 mapping 由
  `src/core/storage/elasticsearch-precision.ts` 的 `chunkMappings()` / `entityMappings()` 定义，首次写入时自动建索引）。
- **两路词法召回**：Host 排序的 fallback + remainder fill 接 ES 词法臂，
  Neo4j 图臂种子由向量路 + ES 词法路 RRF 融合产生（同一 RRF 常数 k=60，两次独立调用）。
- **降级语义**：`unconfigured` → 词法臂缺席、不设 degraded（loud-skip）；
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
        "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED": "true",
        "ANTHROPIC_AUTH_TOKEN": "<rerank-api-token>",
        "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "GRAPHRAG_MEMORY_ANTHROPIC_MODEL": "MiniMax-M3",
        "GRAPHRAG_MEMORY_ES_URL": "",
        "GRAPHRAG_MEMORY_ES_CHUNK_INDEX": "",
        "GRAPHRAG_MEMORY_ES_ENTITY_INDEX": "",
        "GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS": ""
      }
    }
  }
}
```

rerank 默认开启，模型和 endpoint 默认分别为 `MiniMax-M3` 与
`https://api.minimaxi.com/anthropic`。Embedding key 的兼容 aliases 与 secret
放置规则见 [`docs/mcp-config.md`](docs/mcp-config.md)。

## MCP Tools

| Tool       | 输入                                                          | 输出          | 说明                                            |
| ---------- | ------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| `ingest`   | `{content, source_ref, metadata?, valid_from?, valid_until?}` | `{chunk_ids}` | 写入：chunk → embed → store                     |
| `retrieve` | `{query, valid_at?, filters?, limit?}`                        | `{chunks[]}`  | 读取：embed → vector search + valid_window 过滤 |
| `echo`     | `{message}`                                                   | `{message}`   | 健康检查                                        |

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

## 约束

- TS strict ESM · Node ≥20 · Vitest
- 不依赖 iknow runtime（zero import from iknow `src/`）
- 不引入任何外部项目源码 / 二进制作运行时依赖；本地若存有上游参考目录，仅作离线对照，禁止 runtime 链接 / import / symlink / 动态加载
- env 名不写明文（API key 通过 `*_API_KEY_ENV` 间接寻址）
