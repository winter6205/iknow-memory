# iknow-memory

外置记忆 MCP 服务。

## 定位

- **外置记忆服务**：通过 MCP（Model Context Protocol）接入任何智能体 host
- **host-agnostic**：不依赖任何特定 host（iknow / Claude Code / 自定义 agent 均可接入）
- **不做上下文工程**：JIT retrieval / cache 布局 / 上下文组装是 host 的事，server 只负责"存得对、查得准、可时间切片"
- **自洽定位**：以混合检索、分层记忆与 bi-temporal 时间模型为基础能力；以 LLM 三元组抽取、canonical 实体合并、PPR 多跳、社区检测为迭代方向（不绑任何外部学习对象）

## 当前状态

- **阶段 0+1 已完成**：chunks-only ingest/retrieve + vector cosine + valid_window 时间切片
- **P0 规划中**：三元组抽取 + canonical 实体合并（升级方案 ROI 最高；P0a schema 原型已验证，见 `acff699`）
- **后续**：P1 图检索（PPR + node embedding）→ P2 时间/因果 → P3 社区

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

在 host 的 `.mcp.json` 中注册：

```json
{
  "mcpServers": {
    "iknow-memory": {
      "command": "node",
      "args": ["path/to/iknow-memory/dist/index.js"],
      "env": {
        "GRAPHRAG_MEMORY_STORAGE": "memory",
        "GRAPHRAG_MEMORY_EMBED_DIMENSIONS": "2048"
      }
    }
  }
}
```

pgvector 模式：

```json
{
  "mcpServers": {
    "iknow-memory": {
      "command": "node",
      "args": ["path/to/iknow-memory/dist/index.js"],
      "env": {
        "GRAPHRAG_MEMORY_STORAGE": "pgvector",
        "GRAPHRAG_MEMORY_DB_URL": "postgresql://...",
        "GRAPHRAG_MEMORY_EMBED_DIMENSIONS": "2048",
        "GRAPHRAG_MEMORY_EMBED_MODEL": "zhipueb/embedding-3",
        "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV": "ANTHROPIC_AUTH_TOKEN"
      }
    }
  }
}
```

> **Base URL**：`GRAPHRAG_MEMORY_EMBED_BASE_URL` 不写死在 `.mcp.json` 里。
> 优先从进程环境继承（`~/.bashrc` 动态网关探测），fallback 到项目根
> `.env.local`（gitignored）。WSL 环境下网关 IP 会变，写死会失效。

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

## 约束

- TS strict ESM · Node ≥20 · Vitest
- 不依赖 iknow runtime（zero import from iknow `src/`）
- env 名不写明文（API key 通过 `*_API_KEY_ENV` 间接寻址）
