# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> **Tracker = 仓库内文件。** 不要 `gh issue view` / `gh issue create`；云端 / PR remote 往往看不到 Issues。
> 本文件是索引，不是第二份 spec。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；检索质量可测并可迭代提升，且能被标准 Host 使用。

## Live 进度（2026-08-29）

| 项                            | 状态          | 证据（文件 / 已合 PR）                                                                             |
| ----------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| 地基 Stage 0+1 + P0 wiring    | on main       | `plans/p0-wiring-closure.md` · PR #54                                                              |
| BM25 + SQL 图臂归档           | CLOSED        | PR #68                                                                                             |
| Neo4j outbox + PPR 图臂       | CLOSED        | PR #77 · `plans/neo4j-graph-arm.md`                                                                |
| Host T-007 + P@5 harness      | CLOSED        | PR #81 / #87                                                                                       |
| 图优先排序                    | CLOSED        | PR #94 · `plans/retrieve-graph-priority.md`                                                        |
| 临时 LLM 精排（quality T1）   | CLOSED        | PR #118 · `plans/retrieve-rerank-llm.md`                                                           |
| 图/精排 fail-start + 证据留档 | **OPEN**      | `specs/graph-rerank-boot-and-evidence.md` · `plans/graph-rerank-boot-and-evidence.md`              |
| 余下检索/图谱质量             | **OPEN 子图** | [map-retrieve-graph-quality.md](map-retrieve-graph-quality.md) · `plans/retrieve-graph-quality.md` |
| #15 抽取 F1                   | **后置**      | 不进质量子图；勿开工                                                                               |

**下回合：** 先做 `plans/graph-rerank-boot-and-evidence.md`。质量栈 T2–T11 仍见 `plans/retrieve-graph-quality.md`，不与第一刀混开。

## 明确未做（勿当成已关）

见 `plans/retrieve-graph-quality.md` T2–T11；以及后置的 #15、多粒度切分、Neo4j 节点 embedding。

## 云端 / 无 issue 怎么读

1. 本文件（父图索引）
2. [map-retrieve-graph-quality.md](map-retrieve-graph-quality.md)
3. `plans/retrieve-graph-quality.md`（实施 SSOT）
4. `specs/retrieve-graph-quality.md`（合同）
5. `docs/CONTEXT.md`（词汇）
