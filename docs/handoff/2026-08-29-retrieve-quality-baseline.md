# Session Handoff — retrieve quality 当前起点 (2026-08-29)

## 当前 live 状态

- **任务**: 把已合入的检索主线收成「当前起点」，质量栈从 T2 继续；tracker 只认仓库文件。
- **为什么重要**: #118 / #117 已合；旧 map 仍指向 T1；云端看不到 GitHub Issues，不能写 issue。
- **operator 显式指令**: 整理旧完整计划为当前起点；不用写 issue，远端看不到。

## 已固化工件（引用，不复制 inline）

| 类型                  | 路径                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| 领域词汇              | `docs/CONTEXT.md`                                                                                |
| 质量合同              | `specs/retrieve-graph-quality.md`                                                                |
| 质量计划（实施 SSOT） | `plans/retrieve-graph-quality.md`                                                                |
| 父图索引              | `docs/handoff/wayfinder-tickets/map-1.md`                                                        |
| 质量子图              | `docs/handoff/wayfinder-tickets/map-retrieve-graph-quality.md`                                   |
| 质量 ticket 表        | `docs/handoff/wayfinder-tickets/retrieve-graph-quality.md`                                       |
| 已关闭：精排          | `plans/retrieve-rerank-llm.md` · `docs/handoff/wayfinder-tickets/retrieve-rerank-llm.md`         |
| 已关闭：图优先        | `plans/retrieve-graph-priority.md` · `docs/handoff/wayfinder-tickets/retrieve-graph-priority.md` |
| 项目 README 状态      | `README.md` →「当前状态」                                                                        |

## 本 session 变更

| 变更（文件路径）                                                    | 一行效果                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| `94b34f3` / `1659bd7`（已合）                                       | #118 临时 LLM rerank、#117 质量合同进 main                |
| `plans/retrieve-graph-quality.md`                                   | 加 Baseline；Frontier=T2 或并行 T3–T5；禁止 issue tracker |
| `docs/handoff/wayfinder-tickets/*`                                  | map/ticket 对齐当前起点；精排/图优先标 CLOSED             |
| `plans/retrieve-rerank-llm.md` / `plans/retrieve-graph-priority.md` | End of round 标 CLOSED                                    |
| `README.md`                                                         | 「当前状态」追上 main                                     |
| `docs/CONTEXT.md`                                                   | Neo4j/PPR/outbox stage 去掉「pending merge」              |
| `specs/retrieve-graph-quality.md`                                   | 头注：slice 0 on main；tracker=文件                       |
| 本文件                                                              | 交接指针                                                  |

## 已验证状态

```
git log -1 --oneline
=> 1659bd7 docs(retrieve): spec and plan for the Host retrieve quality stack (#117)

gh pr list --state open
=> []（合并 #118/#117 后无开放 PR）
```

本整理为文档-only；未重跑全量 `npm test`。

## Open blockers + next steps

**[NEXT] 按 `plans/retrieve-graph-quality.md` 实施 T2（dedicated HTTP rerank）：先写失败测试，再最小实现，一刀一 commit；不要 `gh issue`。**

- 或并行开工 T3 / T4 / T5（投影 GC / 自环 reject / `merged_into`）
- live smoke（`docs/runbooks/retrieve-rerank-smoke.md`）仍需 Postgres + `ANTHROPIC_AUTH_TOKEN`，非阻塞下一刀

## Suggested skills（下个 agent 建议 invoke）

- `test-driven-development` — T2 实现
- `using-agent-skills` — 若下一刀不是 T2

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据用环境变量名：`ANTHROPIC_AUTH_TOKEN`、`GRAPHRAG_MEMORY_EMBED_API_KEY`、`GRAPHRAG_MEMORY_VECTOR_API_KEY`
