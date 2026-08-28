# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> 云端 / 无 `issues` 权限时用本文件当低分辨率地图。GitHub 仍是 tracker SSOT（[#1](https://github.com/winter6205/iknow-memory/issues/1)），但 **不要假设下一会话能 `gh issue view`**。
> 本文件是索引，不是第二份 spec。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；检索质量可测并可迭代提升，且能被标准 Host 使用。

## Live 进度（2026-08-28）

| 项                | 状态     | 证据                                                                                                       |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 父图 #1           | OPEN     | 地基 + 已合入检索主线                                                                                      |
| 余下检索/图谱质量 | **子图** | [检索与图谱质量：完整 Host retrieve 栈](map-retrieve-graph-quality.md) · `specs/retrieve-graph-quality.md` |
| 图优先排序        | CLOSED   | PR #94                                                                                                     |
| 精排形态          | CLOSED   | #88；slice 0 实施仍是 #92                                                                                  |
| #15 抽取 F1       | **后置** | 不进质量子图                                                                                               |

**下回合：** 质量栈 **T1** — `plans/retrieve-graph-quality.md` / `plans/retrieve-rerank-llm.md`（PR 远端只认文件，不认 issue）。

逐问细票 #96–#102 已由质量子图 + 总 spec 替代，勿再当 frontier。
