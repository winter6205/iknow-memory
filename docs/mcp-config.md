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
  三种不一致的语义见下文[空字符串 pin](#空字符串-pin)。
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
本机重依赖用仓库根目录 `docker compose up -d --wait`（infra only，MCP 仍在宿主机）。
Compose 开发凭据与要写进 `.env.local` 的连接串见
[`docs/runbooks/local-infra.md`](runbooks/local-infra.md)。
无 Docker 时图 sidecar：`bash scripts/neo4j.sh start`（`127.0.0.1`、关闭认证，只需 URI）。
精度层缺 `GRAPHRAG_MEMORY_ES_URL` 会 fail-start（ADR-0007）。

### 三条 URL 各自怎么填

下面只列**地址**。凭据按上节同样以 placeholder 出现；放法见文末
[Compose 开发凭据 vs 本机已有实例](#compose-开发凭据-vs-本机已有实例)。

**`GRAPHRAG_MEMORY_DB_URL`** — PostgreSQL + pgvector 连接串，形如
`postgresql://<user>:<password>@<host>:5432/<db>`。

**`GRAPHRAG_MEMORY_NEO4J_URI`** — Neo4j Bolt URI，形如 `bolt://<host>:7687`。
Neo4j 开启认证时（Compose 默认）必须同时给
`GRAPHRAG_MEMORY_NEO4J_USER` / `GRAPHRAG_MEMORY_NEO4J_PASSWORD`；无认证的
sidecar 只需 URI。

**`GRAPHRAG_MEMORY_ES_URL`** — 单个 ES 节点地址，形如 `http://<host>:9200`。
这是连接地址，不是 feature switch：缺地址会让默认开启的精度层拒绝启动
（ADR-0007 fail-start）。WSL 上用 `127.0.0.1` 而非 `localhost`，见下节。

### WSL：ES 用 `127.0.0.1`，不要赌 `localhost` 的解析顺序

WSL 下 `/etc/hosts` 同时有 `127.0.0.1 localhost` 与 `::1 localhost`，而
`localhost` 解析到 IPv4 还是 IPv6 由 `getaddrinfo` 的地址排序决定，不受
iknow-memory 控制。容器只发布 IPv4（如 `-p 127.0.0.1:9200:9200`）而解析
先返回 `::1` 时，报错是 `ECONNREFUSED` 或 **`ECONNRESET`**（对端回 RST），
不是清晰的 "ES 没起"。写死 `127.0.0.1` 就没有这一档不确定性，且容器、WSL
正向代理、Docker Desktop 转发下都成立。

同一台机器上两个 curl 可以都好：Compose 的 `9200:9200` 默认同时占
`0.0.0.0:9200` 与 `[::]:9200`，两条路径都通（本机实测确实如此）。风险在于
解析结果本身不稳定——本机 `getent hosts localhost` 返回 `::1`，而 Node 的
`dns.lookup("localhost")` 返回 `127.0.0.1`，两个标准工具在同一台机器上就不
一致。一旦换成只绑 IPv4 的发布（例如 `127.0.0.1:9200:9200`，它不附带 IPv6
监听），走 IPv6 的那一侧立刻变成 `ECONNREFUSED` / `ECONNRESET`。文档给固定
地址，是去掉这一档运气。

本仓库跟踪的 MCP 模板 / `.env.example` 仍写 `http://localhost:9200`（沿用
既有约定）；host 本地注册建议用 `127.0.0.1`。

## 环境变量

下表是 `GraphragEnv` / `loadEnv()` 消费的变量，不是 MCP JSON 必填字段。

| 变量                                          | 用途                                | 示例或默认值                                                                    |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `GRAPHRAG_MEMORY_STORAGE`                     | 存储后端                            | `pgvector`                                                                      |
| `GRAPHRAG_MEMORY_DB_URL`                      | PostgreSQL / pgvector 连接 URL      | `postgresql://iknow_memory:<db-password>@localhost:5432/iknow_memory`           |
| `GRAPHRAG_MEMORY_NEO4J_URI`                   | Neo4j 图投影连接 URI                | `bolt://localhost:7687`                                                         |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`               | 首选 embedding secret               | `<embedding-api-key>`                                                           |
| `GRAPHRAG_MEMORY_EMBED_BASE_URL`              | embedding endpoint                  | `https://open.bigmodel.cn/api/paas/v4`                                          |
| `GRAPHRAG_MEMORY_EMBED_MODEL`                 | embedding model                     | `embedding-3`                                                                   |
| `GRAPHRAG_MEMORY_EMBED_DIMENSIONS`            | embedding vector dimensions         | `1536`（必须 ≤ ANN 上限；本机 HNSW 上限 2000）                                  |
| `GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS` | pgvector HNSW 宽度上限              | `2000`                                                                          |
| `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED`    | rerank 开关                         | `true`（默认）                                                                  |
| `GRAPHRAG_MEMORY_RERANK_API_KEY_ENV`          | 精排密钥变量名（指针）              | `MINIMAX_API_KEY`                                                               |
| `MINIMAX_API_KEY`                             | MiniMax LLM 精排密钥                | `<minimax-api-key>`                                                             |
| `ANTHROPIC_AUTH_TOKEN`                        | 精排/抽取 LLM secret（回退）        | 未设 `RERANK_API_KEY_ENV` 时使用                                                |
| `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL`          | Anthropic-compatible endpoint       | `https://api.minimaxi.com/anthropic`（默认）                                    |
| `GRAPHRAG_MEMORY_ANTHROPIC_MODEL`             | rerank / extract model              | `MiniMax-M3`（默认）                                                            |
| `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL`        | 可选专用 rerank HTTP sidecar        | 留空则走 MiniMax LLM                                                            |
| `GRAPHRAG_MEMORY_ES_URL`                      | Elasticsearch 精度层地址            | 真实 `http(s)://…`；缺省 + 默认开启 = ADR-0007 fail-start（WSL 用 `127.0.0.1`） |
| `GRAPHRAG_MEMORY_ES_NODE`                     | `GRAPHRAG_MEMORY_ES_URL` 的兼容别名 | 与 URL 二选一；两个都设时 URL 优先（`_NODE` 被忽略）                            |
| `GRAPHRAG_MEMORY_ES_CHUNK_INDEX`              | chunk 派生索引名                    | `iknow-memory-chunks`（缺省 / 空串都落到这个默认值）                            |
| `GRAPHRAG_MEMORY_ES_ENTITY_INDEX`             | entity + alias 派生索引名           | `iknow-memory-entities`（同左）                                                 |
| `GRAPHRAG_MEMORY_ES_SUMMARY_INDEX`            | community 报告词法派生索引名        | `iknow-memory-summaries`（同左；由 community-summary 作业投影，非 reindex 覆盖） |

Neo4j 开启认证时（Compose 默认如此），必须同时设置 `GRAPHRAG_MEMORY_NEO4J_USER` 和
`GRAPHRAG_MEMORY_NEO4J_PASSWORD`。共享 / 生产 MCP JSON 里密码只用 placeholder
或 secret store。本机 Compose 的开发默认值只写在
[`docs/runbooks/local-infra.md`](runbooks/local-infra.md) 与 `.env.example`。

### Embedding key 的兼容别名

推荐直接设置 `GRAPHRAG_MEMORY_EMBED_API_KEY`。现有兼容形式按优先级使用：

- `GRAPHRAG_MEMORY_VECTOR_API_KEY`：preferred vector alias；
- `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY`：legacy vector alias，不是 LLM token；
- `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV`：间接形式，值是另一个环境变量的名称，
  例如 `EMBED_API_KEY`，真正的 key 仍放在该环境变量中。

同一 host 只保留一种 embedding key 来源，避免 operator 无法判断最终采用的
secret。

### 空字符串 pin

不要用空串占位。空串不是「用默认值」也不是「关掉这一项」，本进程启动期用
三种不一致的语义处理它：

- `GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS: ""` → 抛 `ConfigError`
  （`X is required and must be a positive integer`），连显式
  `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false` 也拦不住：正整数的解析在
  `parseElasticsearchConfig` 里先于开关执行。
- `GRAPHRAG_MEMORY_ES_CHUNK_INDEX: ""` / `_ENTITY_INDEX: ""` → 静默落到
  `iknow-memory-chunks` / `iknow-memory-entities`；看着像「已配置」，其实没有。
- `GRAPHRAG_MEMORY_DB_URL: ""` / `GRAPHRAG_MEMORY_NEO4J_URI: ""` →
  fail-start 的报错说「未配置」，而环境里明明有这一行（`NEO4J_URI` 的报错原话
  就是 `is not configured`），operator 容易往「变量没写」方向查。

边界：ES 这几个键只有 `GRAPHRAG_MEMORY_ES_URL` 有值、整个 ES block 被真正
解析时才读得到。地址本身也是空串时，`parseElasticsearchConfig` 在解析
chunk / entity / timeout 之前就返回 `undefined`，空串的 timeout 反而不报错
——同一行配置报不报错，取决于另一行，这正是空串不能当占位用的原因。

原因是空串的「屏蔽」副作用：key 只要**存在于** `process.env`（哪怕值是空串），
`src/config.ts` 就把它当成显式的进程值，**不再回退到 `.env.local`**。所以
`"GRAPHRAG_MEMORY_ES_URL": ""` 既读不到 `ES_URL`，也读不到 `.env.local`
里的地址，最终按「无地址」走 ADR-0007 fail-start。要么写真实值，要么整条
key 删掉。想表达「关掉」，用显式开关（例如
`GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false`），不要用空串。

本仓库跟踪的 `.mcp.json` 已收敛为 launch-only：`{ "mcpServers":
{ "iknow-memory": { "command": "node", "args": ["dist/index.js"] } } }`，不含
`env`、不含空串 pin、不含把产品路径钉成 `memory` 的 `GRAPHRAG_MEMORY_STORAGE`。
端点一律落在 host 本地、未被 git 跟踪的注册（如 `~/.cursor/mcp.json`）。

## Compose 开发凭据 vs 本机已有实例

三条 URL 的值取决于连哪里。两种来源并存：**Compose 开发凭据**（
[`docs/runbooks/local-infra.md`](runbooks/local-infra.md) 的凭据表）与本机
**已经在跑**的实例。同一台机器上两种来源会抢同一批端口，同一时刻只用一套。

| URL             | 连仓库 Compose                                                                                                     | 连本机已有实例                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `..._DB_URL`    | `postgresql://iknow_memory:iknow_memory@localhost:5432/iknow_memory`（user/db/password 都是 `iknow_memory`）       | 本机 PostgreSQL 自己的 role / database / 口令（只读探针：`psql -h 127.0.0.1 -p 5432 -U <role> -l`；不写 `-U` 会拿当前 OS 用户名去连并报 `role "<os-user>" does not exist`，role 名也不一定是 `postgres`） |
| `..._NEO4J_URI` | `bolt://localhost:7687`，配 `GRAPHRAG_MEMORY_NEO4J_USER=neo4j` / `GRAPHRAG_MEMORY_NEO4J_PASSWORD=iknow-memory-dev` | `bash scripts/neo4j.sh start` 的无认证 sidecar：只需 URI（脚本默认听 `127.0.0.1`）                                                                                                                        |
| `..._ES_URL`    | `http://127.0.0.1:9200`，无认证（compose 关 security）                                                             | 若已有别的 ES 实例占着 `:9200`，把地址指向它对应的主机端口；security 开着时还要 `GRAPHRAG_MEMORY_ES_USERNAME` + `_PASSWORD`（或 `_API_KEY`），两者不能同时用                                              |

具体填哪套由本机端口主权决定，见
[`docs/runbooks/local-infra.md`](runbooks/local-infra.md)；本文只列两种来源，不预设结论。

## 上线前检查

1. 运行 `npm run build`，确认 `dist/index.js` 存在。
2. 确认 MCP JSON 是 launch-only（无 `env`，或未跟踪注入里没有空串 pin）。
3. 确认 `GraphragEnv`（`.env.local` 或真实 process env）已提供 pgvector、
   DB URL、Neo4j URI（认证开启时含 USER/PASSWORD）、embedding key、MiniMax
   精排配置（或显式 `RERANK_ENABLED=false`），以及 ES 地址（或显式
   `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false`）。
4. 确认实际 secret 没有写入 git 跟踪文件或日志。
5. 重启 host 后调用 `tools/list`，再用 `ingest` / `retrieve` 做最小链路检查。
