# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> 云端 / 无 `issues` 权限时用本文件当低分辨率地图。GitHub 仍是 tracker SSOT（[#1](https://github.com/winter6205/iknow-memory/issues/1)），但 **不要假设下一会话能 `gh issue view`**。
> 本文件是索引，不是第二份 spec。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；检索质量超过 gbrain，且能被标准 Host 使用。

## Live 进度（2026-08-27）

| 项                      | 状态           | 本地路径 / 证据                                                                                                             |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P0 决策 #3/#4/#5/#6/#7  | 闭环           | `docs/CONTEXT.md`；GitHub 票已关                                                                                            |
| SPEC 1–3 + G1–G8 wiring | MERGED on main | PR #11 / #27 / #28 / #54                                                                                                    |
| BM25 + SQL 图臂归档     | MERGED         | [PR #68](https://github.com/winter6205/iknow-memory/pull/68)                                                                |
| Neo4j spec/plan + T1–T5 | MERGED         | [PR #76](https://github.com/winter6205/iknow-memory/pull/76) / [PR #77](https://github.com/winter6205/iknow-memory/pull/77) |
| T-007 Host 验收         | **CLOSED**     | [#79](https://github.com/winter6205/iknow-memory/issues/79)：Cursor MCP echo+ingest+retrieve；无 URI 不 `degraded`          |
| SPEC 4 / T-P0-eval #15  | **后置**       | 子票 #40–#48 勿开工                                                                                                         |
| Map #1                  | OPEN（chart）  | 2026-08-27 #79 闭环                                                                                                         |

**Frontier（决策）：**

1. [#80 检索 P@5 baseline 形态](https://github.com/winter6205/iknow-memory/issues/80) — grilling，未开工

## 路线要点（#57 + #78）

- **关掉** SQL 一跳图臂；不做假图过渡建设
- Postgres 仍是 entities/triples **账本**；真图遍历在 **Neo4j**
- 生产 retrieve：vector + BM25 + Neo4j PPR（0.7 / 0.15 / 0.15）
- Host 验收已过；抽取 F1（#15）与 P1 升级后置

## 明确未做（勿当成已关）

- 检索 P@5 形态（#80）
- `merged_into` 指针落盘；T-P0-eval 代码；多粒度切分

## 云端怎么读

```bash
gh issue view 1
gh issue view 80
```
