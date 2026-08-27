# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> 云端 / 无 `issues` 权限时用本文件当低分辨率地图。GitHub 仍是 tracker SSOT（[#1](https://github.com/winter6205/iknow-memory/issues/1)），但 **不要假设下一会话能 `gh issue view`**。
> 本文件是索引，不是第二份 spec。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；检索质量可测并可迭代提升，且能被标准 Host 使用。

## Live 进度（2026-08-27）

| 项                      | 状态           | 本地路径 / 证据                                                                                                                       |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P0 决策 #3/#4/#5/#6/#7  | 闭环           | `docs/CONTEXT.md`；GitHub 票已关                                                                                                      |
| SPEC 1–3 + G1–G8 wiring | MERGED on main | PR #11 / #27 / #28 / #54                                                                                                              |
| BM25 + SQL 图臂归档     | MERGED         | [PR #68](https://github.com/winter6205/iknow-memory/pull/68)                                                                          |
| Neo4j spec/plan + T1–T5 | MERGED         | [PR #76](https://github.com/winter6205/iknow-memory/pull/76) / [PR #77](https://github.com/winter6205/iknow-memory/pull/77)           |
| T-007 Host 验收         | **CLOSED**     | [#79](https://github.com/winter6205/iknow-memory/issues/79)：Cursor MCP echo+ingest+retrieve；无 URI 不 `degraded`                    |
| P@5 harness             | **CLOSED**     | [#80](https://github.com/winter6205/iknow-memory/issues/80) / [#82](https://github.com/winter6205/iknow-memory/issues/82)；PR #86+#87 |
| SPEC 4 / T-P0-eval #15  | **后置**       | 子票 #40–#48 勿开工                                                                                                                   |
| Map #1                  | OPEN（chart）  | 下回合实施 [#91](https://github.com/winter6205/iknow-memory/issues/91) → [#92](https://github.com/winter6205/iknow-memory/issues/92)  |

**下回合（实施，按序）：**

1. [#91](https://github.com/winter6205/iknow-memory/issues/91) 图优先 T2→T3 — `plans/retrieve-graph-priority.md` — 分支 `feat/retrieve-graph-priority`
2. [#92](https://github.com/winter6205/iknow-memory/issues/92) 精排 T2→T3 — `plans/retrieve-rerank-llm.md` — 分支 `feat/retrieve-rerank-llm`（等 #91）

文档已在 [PR #90](https://github.com/winter6205/iknow-memory/pull/90)（`docs/retrieve-ranking-plans`）。

**Frontier：** 上两项；grilling #88/#89 不再当下一刀。

**#91+#92 之后（[#93](https://github.com/winter6205/iknow-memory/issues/93)）：**

1. 专用精排 HTTP（换掉主模型暂代）
2. 投影删除（账本没了 → 图上删，不是图墓碑）
3. 自环三元组条级错误值（不强制重抽）

仍后置：#15、`merged_into`、多粒度、Louvain、mode bundle、read-your-writes。

## 路线要点（#57 + #78）

- **关掉** SQL 一跳图臂；不做假图过渡建设
- Postgres 仍是 entities/triples **账本**；真图遍历在 **Neo4j**
- 生产 Host 排序：**图优先**（`specs/retrieve-graph-priority.md`）；代码仍为三路 RRF 直至该 spec 落地
- Host 验收与 P@5 harness 已过；抽取 F1（#15）后置
- 精排：临时主模型适配器按 `plans/retrieve-rerank-llm.md`（T2–T3 未实施）

## 明确未做（勿当成已关）

- 专用 cross-encoder HTTP；图投影删除；自环条级 reject — 见 [#93](https://github.com/winter6205/iknow-memory/issues/93)
- `merged_into` 指针落盘；T-P0-eval 代码；多粒度切分
- #15 抽取 F1

## 云端 / 无 issue 怎么读

优先本地（远端不一定能 `gh issue view`）：

- 地图：`docs/handoff/wayfinder-tickets/map-1.md`
- 图优先：`specs/retrieve-graph-priority.md` · `plans/retrieve-graph-priority.md` · `docs/handoff/wayfinder-tickets/retrieve-graph-priority.md`
- 精排：`specs/retrieve-rerank-llm.md` · `plans/retrieve-rerank-llm.md` · `docs/handoff/wayfinder-tickets/retrieve-rerank-llm.md`
- 下回合票：[#91](https://github.com/winter6205/iknow-memory/issues/91) · [#92](https://github.com/winter6205/iknow-memory/issues/92)
- 再下一回合：[#93](https://github.com/winter6205/iknow-memory/issues/93)
