# MCP 配置

本文说明 operator 如何为 host **启动** `iknow-memory` MCP server。

## 配置原则

- 跟踪的 MCP JSON（仓库 `.mcp.json`）只负责 launch：`command` / `args` /
  `cwd`。形状与 aiterm 类似（`command` + `args`）；本仓库未发布到 npm，因此
  `args` 指向已构建的 `dist/index.js`，并用 `cwd` 固定到仓库根，以便
  `loadEnv()` 读取 `.env.local`。
- **设置 SSOT 是 `GraphragEnv`**（`loadEnv()` / 真实 `process.env` /
  `.env.local`）。MCP JSON 不是第二份 RetrieveConfig。
- 未跟踪的 host JSON（例如 `.cursor/mcp.json`、`~/.claude.json`）**可以**注入
  `env`，仅用于密钥或覆盖；这是可选注入，不是第二份 settings 文件。
- **禁止空字符串 pin**（`"GRAPHRAG_MEMORY_ES_URL": ""` 等）。键一旦出现在
  `process.env` 就会挡住 `.env.local`，空地址还会触发 ADR-0007 fail-start。
- 开关：显式 `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false` 等。地址：真实
  URL，永远不要用空串当开关。
- API key、数据库密码等 secret 只使用下文的 placeholder 代替，实际值放在
  `.env.local`、真实 process env，或未跟踪 host 的可选 `env` 注入。
- 跟踪文件里的 `args` 必须是相对路径（`dist/index.js`），`cwd` 用 `"."`；
  不要提交本机绝对路径。

## 推荐注册（launch-only）

把以下 server 条目合并到 host 的 MCP JSON。跟踪副本见仓库根 `.mcp.json`。
本机未跟踪副本把 `cwd` 换成仓库绝对路径即可。

```json
{
  "mcpServers": {
    "iknow-memory": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "."
    }
  }
}
```

生产设置（pgvector、Neo4j、embedding、rerank、ES 地址）写在 `GraphragEnv`
里，而不是写进跟踪的 MCP JSON。未跟踪 host 若要注入密钥，只写真实非空值。

rerank 默认开启，生产路径是 MiniMax LLM（Anthropic 兼容 HTTP）。
`GRAPHRAG_MEMORY_RERANK_API_KEY_ENV` 指向真实密钥变量（例如 `MINIMAX_API_KEY`）；
未设指针时回退 `ANTHROPIC_AUTH_TOKEN`。两者同时存在时以指针为准。
`GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL` 是专用 rerank sidecar（另一套 JSON
契约），不是 MiniMax base URL。本机 pgvector HNSW 不能索引超过 2000 维，
`GRAPHRAG_MEMORY_EMBED_DIMENSIONS` 必须 ≤ `GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS`。
本地图 sidecar：`bash scripts/neo4j.sh start`。

## 环境变量

下表是 `GraphragEnv` / `loadEnv()` 消费的变量，不是 MCP JSON 必填字段。

| 变量                                          | 用途                           | 示例或默认值                                                          |
| --------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `GRAPHRAG_MEMORY_STORAGE`                     | 存储后端                       | `pgvector`                                                            |
| `GRAPHRAG_MEMORY_DB_URL`                      | PostgreSQL / pgvector 连接 URL | `postgresql://iknow_memory:<db-password>@localhost:5432/iknow_memory` |
| `GRAPHRAG_MEMORY_NEO4J_URI`                   | Neo4j 图投影连接 URI           | `bolt://localhost:7687`                                               |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`               | 首选 embedding secret          | `<embedding-api-key>`                                                 |
| `GRAPHRAG_MEMORY_EMBED_BASE_URL`              | embedding endpoint             | `https://open.bigmodel.cn/api/paas/v4`                                |
| `GRAPHRAG_MEMORY_EMBED_MODEL`                 | embedding model                | `embedding-3`                                                         |
| `GRAPHRAG_MEMORY_EMBED_DIMENSIONS`            | embedding vector dimensions    | `1536`（必须 ≤ ANN 上限；本机 HNSW 上限 2000）                        |
| `GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS` | pgvector HNSW 宽度上限         | `2000`                                                                |
| `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED`    | rerank 开关                    | `true`（默认）                                                        |
| `GRAPHRAG_MEMORY_RERANK_API_KEY_ENV`          | 精排密钥变量名（指针）         | `MINIMAX_API_KEY`                                                     |
| `MINIMAX_API_KEY`                             | MiniMax LLM 精排密钥           | `<minimax-api-key>`                                                   |
| `ANTHROPIC_AUTH_TOKEN`                        | 精排/抽取 LLM secret（回退）   | 未设 `RERANK_API_KEY_ENV` 时使用                                      |
| `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL`          | Anthropic-compatible endpoint  | `https://api.minimaxi.com/anthropic`（默认）                          |
| `GRAPHRAG_MEMORY_ANTHROPIC_MODEL`             | rerank / extract model         | `MiniMax-M3`（默认）                                                  |
| `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL`        | 可选专用 rerank HTTP sidecar   | 留空则走 MiniMax LLM                                                  |
| `GRAPHRAG_MEMORY_ES_URL`                      | Elasticsearch 地址（非开关）   | 真实 `http(s)://…`；缺省且 BM25 默认开 → ADR-0007 fail-start          |

Neo4j 开启认证时，另行设置 `GRAPHRAG_MEMORY_NEO4J_USER` 和
`GRAPHRAG_MEMORY_NEO4J_PASSWORD`；后者只能使用 secret placeholder 或 secret
store，不能提交实际值。

### Embedding key 的兼容别名

推荐直接设置 `GRAPHRAG_MEMORY_EMBED_API_KEY`。现有兼容形式按优先级使用：

- `GRAPHRAG_MEMORY_VECTOR_API_KEY`：preferred vector alias；
- `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY`：legacy vector alias，不是 LLM token；
- `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV`：间接形式，值是另一个环境变量的名称，
  例如 `EMBED_API_KEY`，真正的 key 仍放在该环境变量中。

同一 host 只保留一种 embedding key 来源，避免 operator 无法判断最终采用的
secret。

## 上线前检查

1. 运行 `npm run build`，确认 `dist/index.js` 存在。
2. 确认 MCP JSON 是 launch-only（无 `env`，或未跟踪注入里没有空串 pin）。
3. 确认 `GraphragEnv`（`.env.local` 或真实 process env）已提供 pgvector、
   DB URL、Neo4j URI、embedding key、MiniMax 精排配置（或显式
   `RERANK_ENABLED=false`），以及 ES 地址（或显式
   `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false`）。
4. 确认实际 secret 没有写入 git 跟踪文件或日志。
5. 重启 host 后调用 `tools/list`，再用 `ingest` / `retrieve` 做最小链路检查。
