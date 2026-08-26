# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> 云端 / 无 `issues` 权限时用本文件当低分辨率地图。GitHub 仍是 tracker SSOT（[#1](https://github.com/winter6205/iknow-memory/issues/1)），但 **不要假设下一会话能 `gh issue view`**。
> 本文件是索引，不是第二份 spec。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；可被标准 Host 使用。

## Live 进度（2026-08-26 · 路线重置）

| 项                             | 状态           | 本地路径 / 证据                                                                                                                           |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P0 决策 #3/#4/#5/#6/#7         | 闭环           | `docs/CONTEXT.md`；GitHub 票已关                                                                                                          |
| SPEC 1–3 + G1–G8 wiring        | MERGED on main | PR #11 / #27 / #28 / #54                                                                                                                  |
| 路线重置 grilling              | **CLOSED**     | [#57](https://github.com/winter6205/iknow-memory/issues/57)：关 SQL 图臂 → BM25 → Neo4j                                                   |
| BM25 形态 grilling             | **CLOSED**     | [#59](https://github.com/winter6205/iknow-memory/issues/59)：vector+BM25 RRF；tsvector；默认开 fail-open                                  |
| SQL 图臂过渡 / PR #56 融合优先 | **作废**       | 意见书可留史料；不以之为 NEXT                                                                                                             |
| SQL 图臂关闭（#58）            | **已实施**     | [PR #68](https://github.com/winter6205/iknow-memory/pull/68)：默认 wiring 不再传 `graphConfig`；`docs/runbooks/sql-graph-arm-archived.md` |
| BM25 双臂 RRF（#62）           | **已实施**     | [PR #68](https://github.com/winter6205/iknow-memory/pull/68)：`src/core/retrieval/index.ts` + `pgvector-backend.searchLexical`            |
| SPEC 4 / T-P0-eval #15         | **后置**       | 非 frontier；子票 #40–#48 勿开工                                                                                                          |
| Map #1                         | OPEN（chart）  | 2026-08-26 #59 闭环 + #62 实施已回写                                                                                                      |

**Frontier（实施）：**

1. [#62 BM25 + SQL 图臂归档](https://github.com/winter6205/iknow-memory/issues/62) — **已实施，待 [PR #68](https://github.com/winter6205/iknow-memory/pull/68) 合并**；spec/plan：`specs/bm25-retrieve.md` / `plans/bm25-retrieve.md`（T1=#63 含 #58 清理；T2–T5 = #64–#67）
2. Neo4j 真图臂 — 仍在 fog，待 PR #68 合并后再开票

## Research（已闭环，供下会话）

| 票                                                          | 服务 | 一行结论                                                               |
| ----------------------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| [#61](https://github.com/winter6205/iknow-memory/issues/61) | #58  | pg 默认双臂因始终传 `graphConfig`；**最小关掉 = 停传 graphConfig**     |
| [#60](https://github.com/winter6205/iknow-memory/issues/60) | #59  | **本 repo 无 BM25 代码/依赖**；RRF 硬编码两路，加臂必改 types+rrf+编排 |

## 路线要点（#57）

- **关掉** SQL 一跳图臂；不做假图过渡建设
- Postgres 仍是 entities/triples **账本**；真图遍历在 **Neo4j**
- `confidence` = 抽取自评分，不当图排序主算法
- 顺序：**关图臂 → BM25 → Neo4j**

## 明确未做（勿当成已关）

- Neo4j 投影 / 真图臂
- `merged_into` 指针落盘；T-P0-eval 代码；多粒度切分
- T-007 Claude Code 完整 Host 验收

## 云端怎么读

```bash
# 地图 SSOT（若有 gh）
gh issue view 1

# eval 旧方案仍不在 main（后置，勿当 NEXT）
git show feat/p0-eval-spec:specs/p0-eval.md
```
