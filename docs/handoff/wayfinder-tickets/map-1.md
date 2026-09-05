# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> **Tracker = 仓库内文件。** 云端地图 issue [#1](https://github.com/winter6205/iknow-memory/issues/1) 仍 OPEN（关图等 operator）。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；检索质量可测并可迭代提升，且能被标准 Host 使用。

## Live 进度（2026-09-06）

| 项                            | 状态    | 证据（文件 / 已合 PR）                                    |
| ----------------------------- | ------- | --------------------------------------------------------- |
| 地基 Stage 0+1 + P0 wiring    | on main | `plans/p0-wiring-closure.md` · PR #54                     |
| BM25 + SQL 图臂归档           | CLOSED  | PR #68                                                    |
| Neo4j outbox + PPR 图臂       | CLOSED  | PR #77 · `plans/neo4j-graph-arm.md`                       |
| Host T-007 + P@5 harness      | CLOSED  | PR #81 / #87                                              |
| 图优先排序                    | CLOSED  | PR #94 · `plans/retrieve-graph-priority.md`               |
| 临时 LLM 精排（quality T1）   | CLOSED  | PR #118 · `plans/retrieve-rerank-llm.md`                  |
| 质量栈 T2–T11                 | CLOSED  | `plans/retrieve-graph-quality.md` · PR #120 / #123 / #171 |
| #15 抽取 F1 / p0-eval         | CLOSED  | `plans/p0-eval.md` · PR #171（勿重开 #128–#133）          |
| ES 精度层 T14                 | CLOSED  | `plans/es-precision-layer.md` · PR #175                   |
| 图/精排 fail-start + 证据留档 | CLOSED  | `plans/graph-rerank-boot-and-evidence.md` · PR #184       |
| MCP 工具面                    | CLOSED  | `plans/mcp-tool-surface.md` · PR #185                     |

**下回合：** 不要重做上表。剩余：`plans/retrieval-stack.md` T17–T24；flake [#170](https://github.com/winter6205/iknow-memory/issues/170)。关图是 operator stop-gate。

## 明确未做（勿当成已关）

`plans/retrieval-stack.md` T17–T24。多粒度切分、Neo4j 节点 embedding 仍后置。

## 云端 / 无 issue 怎么读

1. 本文件（父图索引）
2. [`2026-09-05-status.md`](../2026-09-05-status.md)
3. `plans/` 各闭合计划
4. `docs/CONTEXT.md`（词汇）
