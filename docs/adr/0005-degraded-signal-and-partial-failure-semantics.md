# 0005. Degraded signal and partial-failure semantics

Date: 2026-08-31
Status: accepted

## Context

Retrieval is composed of multiple capability arms, so a successful response must distinguish a legal empty result from a response produced after an arm could not run or failed. The shared baseline chapter in `specs/retrieval-stack.md` — `## 跨仓对齐基线`, especially §B2 部分失败语义 and §B3 降级信号：形态与消费 — is the sole source for this contract. This ADR does not introduce another set of quantitative baseline values.

The source contract says: “一臂成功即放行” and “全部失败即具名失败”; it also says that a released degraded result is usable but must be visible to the caller. The signal therefore has to survive both capability failure and the caller's handling of the response.

## Decision

The retrieve envelope uses the exact field names `degraded` and `degraded_reasons`. `degraded` is an optional boolean. `degraded_reasons` is an optional bounded list whose entries identify the capability and whether it was unattempted or attempted-and-failed. An absent `degraded` means not degraded, and an absent `degraded_reasons` means an empty list.

The four and only four set rules are:

1. A capability enabled by default cannot be attempted because its credentials or address are missing → set `degraded`. **Exception (ADR-0006):** default-on **graph** and **rerank** in this case refuse process start (`ConfigError`) instead of starting and setting `degraded`. Vector, BM25, and Elasticsearch still follow this rule.
2. An attempted capability call fails → set `degraded`.
3. A capability was attempted but found no hits → do **not** set `degraded`.
4. A capability explicitly switched off by the caller → do **not** set `degraded`.

Partial-failure handling follows §B2. If at least one arm succeeds, including by returning an empty result, the response is released. If another arm failed or could not be attempted, the released response carries `degraded` and names that arm in `degraded_reasons`; when all arms succeed, an empty result is not degradation. If all arms fail, the service returns a typed, named error rather than an empty result or an unmarked partial result. A vector-arm failure with no graph hit is treated as all arms failing.

Callers must read and surface the signal. When `degraded` is true, callers must handle the response according to §B2, expose the degraded state to the user side, and record its reasons; they must not treat degraded as an ordinary empty result, use it as a complete result, or ignore the marker. Ignoring or hiding the marker is a contract violation.

The following silent shapes are prohibited substitutes for the signal or typed failure:

- deterministic pseudo-vectors;
- empty results masquerading as failure;
- silent skip;
- unmarked sequential fallback.

Missing embedding credentials must not be papered over with deterministic pseudo-vectors. The vector capability is unattemptable under rule 1, so the response must carry `degraded` and a corresponding `degraded_reasons` entry instead.

## Consequences

- Capability failures and unattemptable default-on capabilities remain visible without misclassifying legal empty results.
- Partial results remain usable only with an explicit degraded signal; all-failed calls remain typed failures.
- Consumers and evaluation paths must preserve and inspect `degraded` and `degraded_reasons` rather than infer failure from an empty result.

Evidence pointers: `specs/retrieval-stack.md` shared baseline chapter (§B2 and §B3).
