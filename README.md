# iknow-memory

外置知识记忆 MCP 服务（host-agnostic，以 gbrain 为学习对象）。

## 定位

- **外置记忆服务**：通过 MCP（Model Context Protocol）接入任何智能体 host
- **host-agnostic**：不依赖任何特定 host（iknow / Claude Code / 自定义 agent 均可接入）
- **不做上下文工程**：JIT retrieval / cache 布局 / 上下文组装是 host 的事，server 只负责"存得对、查得准、可时间切片"
- **以 gbrain 为学习对象**：优点全部实现（混合检索 / 分层记忆 / bi-temporal），缺点全部改进（三元组抽取 / canonical 实体合并 / PPR 多跳 / 社区检测）

## 当前状态

- **阶段 0+1 已完成**：chunks-only ingest/retrieve + vector cosine + valid_window 时间切片
- **P0 进行中**：三元组抽取 + canonical 实体合并（升级方案 ROI 最高）
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
        "IKNOW_MEMORY_STORAGE": "memory",
        "IKNOW_MEMORY_EMBED_DIMENSIONS": "2048"
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
        "IKNOW_MEMORY_STORAGE": "pgvector",
        "IKNOW_MEMORY_DB_URL": "postgresql://...",
        "IKNOW_MEMORY_EMBED_DIMENSIONS": "2048",
        "IKNOW_MEMORY_EMBED_BASE_URL": "http://localhost:20128/v1",
        "IKNOW_MEMORY_EMBED_MODEL": "zhipueb/embedding-3",
        "IKNOW_MEMORY_EMBED_API_KEY_ENV": "NINE_ROUTER_KEY"
      }
    }
  }
}
```

## MCP Tools

| Tool | 输入 | 输出 | 说明 |
|------|------|------|------|
| `ingest` | `{content, source_ref, metadata?, valid_from?, valid_until?}` | `{chunk_ids}` | 写入：chunk → embed → store |
| `retrieve` | `{query, valid_at?, filters?, limit?}` | `{chunks[]}` | 读取：embed → vector search + valid_window 过滤 |
| `echo` | `{message}` | `{message}` | 健康检查 |

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
  gbrain-vector-memory-upgrade-guide.html  # 路线骨架（升级方案）
```

## 路线

详见 `docs/gbrain-vector-memory-upgrade-guide.html`（D1-D5 决策 + P0-P3 迁移路径）。

## 约束

- TS strict ESM · Node ≥20 · Vitest
- 不依赖 iknow runtime（zero import from iknow `src/`）
- `_upstream_gbrain/` 只读参考，禁止 runtime 链接 / import / symlink / 动态加载
- env 名不写明文（API key 通过 `*_API_KEY_ENV` 间接寻址）
