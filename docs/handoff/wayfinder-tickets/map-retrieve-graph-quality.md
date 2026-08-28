# Local map index — [wayfinder:map] 检索与图谱质量：完整 Host retrieve 栈

> 父地图: [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务 ([#1](https://github.com/winter6205/iknow-memory/issues/1))
> 合同: `specs/retrieve-graph-quality.md`（slice 0 另见 `specs/retrieve-rerank-llm.md`）
> GitHub: [#103](https://github.com/winter6205/iknow-memory/issues/103)

## Destination（一句）

在现有 `ingest` / `retrieve` 信封上，把检索栈与图谱质量做完：精排、preset、邻块证据、软合并落盘、投影 GC、社区摘要、因果/失效、可选投影等待；可测、默认可关、fail-open；Host 不负责的上下文工程不进本图。

## Notes

本图允许 chart 后直接落 spec。实施走 `writing-plans` 按 slice 拆 commit，不把 slice 0–10 打成一包。

不新开 MCP tool。不复活 SQL 图臂。#15 抽取 F1 仍在父图后置。

## 下一刀

slice 0 = 计划 **T1**：临时 Anthropic LLM 精排。读 `plans/retrieve-graph-quality.md` 与 `plans/retrieve-rerank-llm.md`。不要依赖 GitHub issue。
