# Session Handoff — 操作员完整控制台 wayfinder 图 (2026-09-10)

## 当前 live 状态

- **任务**: 把「全要、但计划只用本产品词表」收成一张 wayfinder 图，下一会话从前线 grilling 开始讨论。
- **为什么重要**: 只读看板已在 main，但零配置/编排器曾绕开 `.env.local`；权威源 `chunks` 与契约不对齐，看板连上 pg 会 fatal。操作员要的是同一权威源上的检视 + 喂满 + 图投影跟上，不是再开一张只读图。
- **operator 显式指令**: `/wayfinder 我全要，打算怎么办，打算不要把gbrian写到我们计划里面`；随后 `/session-handoff 交接一下map任务，我下会话开始讨论`。

## 已固化工件（引用，不复制 inline）

| 类型                 | 路径 / URL                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 领域词汇             | `docs/CONTEXT.md`（iknow-memory dashboard / chunk / ingest / extract / authoritative source）                                                                                                     |
| 只读看板 spec / plan | `specs/iknow-memory-dashboard.md` · `plans/iknow-memory-dashboard.md`                                                                                                                             |
| 前序只读图（勿重开） | https://github.com/winter6205/iknow-memory/issues/188                                                                                                                                             |
| **本图 map**         | https://github.com/winter6205/iknow-memory/issues/201                                                                                                                                             |
| 已关 research        | https://github.com/winter6205/iknow-memory/issues/202 · https://github.com/winter6205/iknow-memory/issues/203                                                                                     |
| 前线 grilling        | https://github.com/winter6205/iknow-memory/issues/204                                                                                                                                             |
| 阻塞中 grilling      | https://github.com/winter6205/iknow-memory/issues/205（等 202，已关故可开）· https://github.com/winter6205/iknow-memory/issues/206（等 203+204）                                                  |
| research 资产        | `docs/wayfinder/research/auth-source-schema.md` @ `research/auth-source-schema` (`4b91f7d`) · `docs/wayfinder/research/operator-feed-surfaces.md` @ `research/operator-feed-surfaces` (`d4c4f85`) |
| 配置 SSOT            | `docs/mcp-config.md` · `.cursor/mcp.json` env · `.env.local`（gitignored；只读键名）                                                                                                              |
| 图投影 runbook       | `docs/runbooks/neo4j-projection.md`                                                                                                                                                               |

## 本 session 变更

| 变更（文件路径）                                      | 一行效果                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| https://github.com/winter6205/iknow-memory/issues/201 | 新建 map：目的地 = 操作员完整控制台；Notes 禁止第三方看板产品名写入 spec/plan                                       |
| issues 202–206                                        | 两 research + 三 grilling；blocking：205←202，206←203+204                                                           |
| `4b91f7d` `research/auth-source-schema`               | schema 事实：`chunks` 仅 id/content，ensureTable 缺 embedding                                                       |
| `d4c4f85` `research/operator-feed-surfaces`           | 喂数/投影入口对照：看板全 GET                                                                                       |
| `ee910be` `fix(dashboard)`                            | 缺 Vite 则 `npm install --prefix dashboard`；`.env.local` 有存储三项则不再强灌 memory；spawn error 也拆整棵子进程树 |
| `e799f48` `test`                                      | CLI/integration/pgvector 子进程套件 5s 超时改 45s（`vitest.config.ts`）+ pgvector 启动预算 20s、stdin 改 pipe       |
| `3eca765` `chore(gitignore)`                          | 忽略 `docs/wayfinder/prototypes/operator-board/` 与 `.playwright-cli/`                                              |

## 已验证状态

```
npx vitest run tests/scripts/dashboard-dev.test.ts
=> exit 0（15 passed）

npm test（三笔提交的 pre-commit 各跑一遍）
=> 131 files passed / 1 skipped；1580 passed / 4 skipped；0 failed

gh issue view 201 / 202 / 203 / 204
=> 201 OPEN map；202 CLOSED；203 CLOSED；204 OPEN 无 assignee

npm run dashboard（honoring .env.local）
=> exit 1；日志 marker: dashboard fatal: PgvectorBackend: ensureTable failed (column "embedding" does not exist)
```

## Open blockers + next steps

**[NEXT] 认领并 grilling [「全要」落在本产品哪些能力面](https://github.com/winter6205/iknow-memory/issues/204)**：`gh issue edit 204 --add-assignee winter6205`，走 `logicsync`；本图 Recommend 仍是「五页真实 chunk + 图投影跟上，喂数先走 MCP/CLI，看板写 HTTP / 导入 UI 不进第一刀」。决议写进 204 的 resolution comment 后关闭，并在 [操作员完整控制台：同一权威源上的检视、喂数与图投影](https://github.com/winter6205/iknow-memory/issues/201) 的 Decisions so far 加一行。

- 204 关闭后再开 [权威源是修补现库还是换干净库](https://github.com/winter6205/iknow-memory/issues/205)（202 已关，不再阻塞）。
- 204 + 203 都关后再开 [看板本轮要不要写路径](https://github.com/winter6205/iknow-memory/issues/206)。
- `dashboard-dev` 三文件已按 `3eca765` / `ee910be` / `e799f48` 提交，与 map 讨论无关；不要和 204 决议混进同一个 commit。
- 工作树仍余 `docs/adr/0007-source-document-text-sor.md`（与 `feat/operator-console-upgrade` 逐字节相同；ADR 删除主权归 domain-modeling，未清理）。
- 图清后默认 `spec-driven-development`；handoff 目标仍要问 operator。

## Suggested skills（下个 agent 建议 invoke）

- `wayfinder` — work-through 模式，map = issue 201，票 = 204
- `logicsync` — 204 是 HITL grilling
- `using-agent-skills` — 开场先定当前槽位（不要叠 spec / plan）

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据只用环境变量名：`GRAPHRAG_MEMORY_DB_URL`、`GRAPHRAG_MEMORY_EMBED_API_KEY`、`MINIMAX_API_KEY`
