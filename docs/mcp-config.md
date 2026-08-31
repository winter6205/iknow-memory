# MCP 配置

本文说明 operator 如何为 host 注册 `iknow-memory` MCP server。

## 配置原则

- Host JSON 中 `mcpServers.iknow-memory.env` 是 MCP 用户配置的 SSOT。
- `.env.local` 仅是本地开发 fallback；生产或共享 host 不依赖它。
- API key、数据库密码等 secret 只使用下文的 placeholder 代替，实际值由
  operator 写入 host 的 secret 管理或未被 git 跟踪的配置。
- `args` 中的路径必须替换为本机已经构建的 `dist/index.js` 路径。

## 推荐注册：pgvector + Neo4j

把以下 server 条目合并到 host 的 MCP JSON（例如 `.mcp.json` 或
`.cursor/mcp.json`）：

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
        "GRAPHRAG_MEMORY_ANTHROPIC_MODEL": "MiniMax-M3"
      }
    }
  }
}
```

rerank 默认开启。未显式覆盖时，模型和 Anthropic-compatible endpoint 分别为
`MiniMax-M3` 与 `https://api.minimaxi.com/anthropic`；示例显式写出默认值，便于
operator 审核最终生效的配置。

## 环境变量

| 变量                                       | 用途                           | 示例或默认值                                                          |
| ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| `GRAPHRAG_MEMORY_STORAGE`                  | 存储后端                       | `pgvector`                                                            |
| `GRAPHRAG_MEMORY_DB_URL`                   | PostgreSQL / pgvector 连接 URL | `postgresql://iknow_memory:<db-password>@localhost:5432/iknow_memory` |
| `GRAPHRAG_MEMORY_NEO4J_URI`                | Neo4j 图投影连接 URI           | `bolt://localhost:7687`                                               |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`            | 首选 embedding secret          | `<embedding-api-key>`                                                 |
| `GRAPHRAG_MEMORY_EMBED_BASE_URL`           | embedding endpoint             | `https://open.bigmodel.cn/api/paas/v4`                                |
| `GRAPHRAG_MEMORY_EMBED_MODEL`              | embedding model                | `embedding-3`                                                         |
| `GRAPHRAG_MEMORY_EMBED_DIMENSIONS`         | embedding vector dimensions    | `1536`                                                                |
| `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED` | rerank 开关                    | `true`（默认）                                                        |
| `ANTHROPIC_AUTH_TOKEN`                     | rerank / LLM secret            | `<rerank-api-token>`                                                  |
| `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL`       | Anthropic-compatible endpoint  | `https://api.minimaxi.com/anthropic`（默认）                          |
| `GRAPHRAG_MEMORY_ANTHROPIC_MODEL`          | rerank model                   | `MiniMax-M3`（默认）                                                  |

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
2. 确认 host JSON 的 `env` 已包含 pgvector、DB URL、Neo4j URI、embedding key
   和 rerank 配置。
3. 确认实际 secret 没有写入 git 跟踪文件或日志。
4. 重启 host 后调用 `echo`，再用 `ingest` / `retrieve` 做最小链路检查。
