# Local map index — [wayfinder:map] iknow-memory：自研外置记忆 MCP 服务

> 云端 / 无 `issues` 权限时用本文件当低分辨率地图。GitHub 仍是 tracker SSOT（[#1](https://github.com/winter6205/iknow-memory/issues/1)），但 **不要假设下一会话能 `gh issue view`**。
> 本文件是索引，不是第二份 spec。细节跟路径走。

## Destination（一句）

自研 host-agnostic 外置知识记忆 MCP；P0 图层接到生产 `ingest → extract → retrieve` 后，下一实施项是抽取质量评估门禁。

## Live 进度（2026-08-26）

| 项                     | 状态               | 本地路径 / 证据                                                                              |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| P0 决策 #3/#4/#5/#6/#7 | 闭环               | `docs/CONTEXT.md`；GitHub 票已关                                                             |
| SPEC 1 schema          | MERGED             | `specs/p0-schema.md`；PR #11                                                                 |
| SPEC 2 extraction      | MERGED             | `specs/p0-extraction.md`；PR #27                                                             |
| SPEC 3 integration     | MERGED             | `specs/p0-integration.md`；PR #28                                                            |
| G1–G8 wiring-closure   | **MERGED on main** | `specs/p0-wiring-closure.md`、`plans/p0-wiring-closure.md`；PR #54 merge `90410a4`           |
| SPEC 4 / T-P0-eval     | **不在 main**      | 分支 `feat/p0-eval-spec`：`specs/p0-eval.md`、`plans/p0-eval.md`；PR #49 **closed 未 merge** |
| Map #1 issue           | OPEN（chart）      | 2026-08-26 已回写 tracker 评论；云端可能看不到                                               |

**Frontier（实施）：** T-P0-eval（GitHub #15，子票 #40–#48）。入口本应是 T1 #40（先关 spec Open Questions），但 operator 下一会话意图是 **方案改进/调整**，不是直接按旧 plan 开工。

## 生产路径已接线（G1–G8 摘要，细节见 spec）

写路径：entity embedding + description（`metadata` JSONB）、`--backfill-embeddings`、`normalizeRelation` 级联、词表 prompt、`entity_aliases` 写入。  
读路径：query 单次 embed + 向量/图臂并发。  
其它：`candidateSet "all"` typed error、`--list-failed`。

## 明确未做（勿当成已关）

- `merged_into` 指针仍不落盘（#13 已知限制；软合并生产等价硬去重）
- T-P0-eval 代码与门禁（spec/plan 只在 `feat/p0-eval-spec`）
- PR #54 body 未粘贴 SC12c p95 数字（plan 称 round-close 0.98× BUDGET_MET）
- `plans/p0-integration.md` Status 行（wiring plan T10，已 drop）
- T-007 Claude Code 完整 Host 验收（upstream `winter6205/iknow#49`）
- `remember` / `store_fact` / `store_preference` 晋升工具；Neo4j / P1–P3

## 云端怎么读 eval 方案（main 上没有这些文件）

```bash
git show feat/p0-eval-spec:specs/p0-eval.md
git show feat/p0-eval-spec:plans/p0-eval.md
```

若本地无该分支：`git fetch origin feat/p0-eval-spec` 后再 `show`。
