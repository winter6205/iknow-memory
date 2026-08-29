# Local map index — [wayfinder:map] 检索与图谱质量：完整 Host retrieve 栈

> 父地图: [map-1.md](map-1.md)
> 合同: `specs/retrieve-graph-quality.md`（slice 0 已合：`specs/retrieve-rerank-llm.md`；slice 8 细节：`specs/retrieve-community.md` / `plans/retrieve-community.md`）
> **不要用 GitHub issues 当 tracker。**

## Destination（一句）

在现有 `ingest` / `retrieve` 信封上，把检索栈与图谱质量做完：专用精排、preset、邻块证据、软合并落盘、投影 GC、社区摘要、因果/失效、可选投影等待；可测、默认可关、fail-open；Host 不负责的上下文工程不进本图。

## Baseline（已在 main，勿重做）

- Graph-priority Host 排序 — PR #94
- Temporary LLM rerank（slice 0 / plan T1）— PR #118，默认 off
- 合同 + 本计划 — PR #117

## Notes

实施按 `plans/retrieve-graph-quality.md` 一刀一 commit。不新开 MCP tool。不复活 SQL 图臂。#15 抽取 F1 仍后置。

## 下一刀

**T2** 专用 HTTP rerank（替换临时适配器，同 hook），或并行 **T3 / T4 / T5**。  
读 `plans/retrieve-graph-quality.md` + [retrieve-graph-quality.md](retrieve-graph-quality.md)。
