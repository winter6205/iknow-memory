# Plan: Retrieval Stack 定档 B (precision layer + in-place vector index + graph default-on + eval)

**Goal:** iknow-memory's retrieval stack runs 定档 B end to end — the Elasticsearch
precision layer at both the entity-finding and fallback stages, a real vector index
built in place on the existing Postgres vector extension, the graph arm on by default
as the main path, every capability on by default, and an eval + concurrency harness
that prints percentage deltas against a baseline and can be merged with fin's report.
**Approach:** Phase 0 first: gate the shared cross-repo baseline, then record the two
ADRs that the rest of the plan inherits (no re-chunking; degraded signal and partial
failure). After that the write side (as-is ingest, idempotency, invalidation, batch +
pool) and the read side (degraded envelope, per-capability defaults, precision layer,
vector index, graph default-on, self-check) run as one parallel cluster, mirroring
fin's phase 1 line B; the dataset line (phase 1 line C) runs alongside. Ablation,
quantified report, and concurrency close the round. Coarse bullets on purpose —
analyzer choice, dimension-reduction method, index type, idempotency mechanism, and
entry-point location are all implementer headroom declared in the spec. Structure
gates (function length, branch count, parameter caps) belong to `complexity-anti-drift`
and are deliberately not restated in any Acceptance below.
**Spec link:** `specs/retrieval-stack.md` (binding; SC = Success Criteria; §B1–§B6 = the cross-repo baseline shared verbatim with fin)
**ACR:** passed — the five-line verdict came back all yes against `specs/retrieval-stack.md`; recorded below.
**Cross-repo alignment:** fin's master plan `plans/retrieval-upgrade.md` runs phase 0 (shared baseline) serially, then line A (parsing + chunking) / line B (this repo's retrieval stack) / line C (dataset) in parallel under phase 1, then phase 2 (ingest push, needs A + B) and phase 3 (ablation + quantified + concurrency). This plan covers line B, the retrieval-side half of line C, the phase-2 retrieval-side capabilities (idempotency, invalidation), and the retrieval-side half of phase 3. fin owns parsing, chunking, the citation gate, orchestration, intent, and short-term memory; nothing here re-slices content.
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch
**Tracker:** This file is the tracker for this round (operator-directed, in-file tracker). No GitHub issue is created; blocking edges are the `[blocks:]` marks written inside this file, and status is each bullet's `Status` checkbox.

## architecture-change-reviewer verdict

Gate ran on `specs/retrieval-stack.md` after the assumption gate (R1–R4) and before this plan was written. Result:

The gate ran against `specs/retrieval-stack.md` before this plan was written; all five lines came back yes.

**Assumption gate (R1–R4): closed.** The four items were finalized and written back into the shared baseline §B1; the "待确认建议值" note is gone and every row of that table is now a finalized contract. Concurrency and latency split into L1 (retrieval / read path, no LLM: 16 concurrent, 120 s, 9:1 read/write, ≥ 1200 total requests, p95 ≤ 800 ms, p99 ≤ 2000 ms) and L2 (full run with LLM: 8 concurrent, 120 s, its own p50 < 60 s and p95 ≤ 120 s, produced by fin); the eval-set chunk floor moved from ≥ 5000 to ≥ 20000 and ≤ 120000; new rows cover 查询分档, 语料来源与许可 (three provenance tiers) and 评测资源预算; ablation runs a scripted 20–40 query subset. No task in this plan owns that decision — it landed directly in the two specs, and there is no T1-equivalent entry to close here.

bounded-context-guardian: yes
defensive-contract-validator: yes
error-handling-enforcer: yes
complexity-anti-drift: yes
minimal-change-verifier: yes

OVERALL: PASSED — implementation may start at T1.

## 待写入

- CONTEXT **chunk** / **ingest** entries and the relationship row `content → chunker → chunk[]` still say chunking happens during this repo's ingest; that is the direction the spec reverses (C-11). Flip to "chunking is fin's; iknow-memory stores and recalls pushed text as-is" — owner: T2, flushed in T24.
- ADR-0004 candidate "retrieval-side chunking exits: no re-chunking" (spec persist item 11) — owner: T2.
- ADR-0005 candidate "degraded signal and partial-failure semantics" (spec persist item 12) — owner: T3.
- CONTEXT **RetrieveConfig**: fusion parameters (RRF k, vector / keyword weights) configurable, default k=60 unchanged (spec persist item 7) — owner: T16, flushed in T24.
- Already flushed by the docs commit on this branch, so not carried here: **precision layer**, **authoritative source**, **derived index**, **ingest idempotency**, **content invalidation**, **ablation**, **concurrency benchmark**, **degraded=true** four rules, **BM25** / **vector search** / **rerank** / **Neo4j graph arm** re-decisions, and ADR-0003.
- No ADR is reopened or contradicted by this plan; ADR-0001 stays intact.

## Tasks (ordered by dependency)

Tracker index for this round: every bullet at a glance, with its dependencies and status. Status here mirrors each bullet's own `Status` checkbox (keep the two in sync); blocking edges are the `[blocks:]` marks written in this file, and bullets marked `[parallel]` may run alongside the others in the same cluster.

| #   | Title                                                                                | Tag                | Blocked by         | Parallel | Status  |
| --- | ------------------------------------------------------------------------------------ | ------------------ | ------------------ | -------- | ------- |
| T1  | Cross-repo baseline drift gate                                                       | `[implementation]` | —                  | —        | Done    |
| T2  | ADR: chunking exits the retrieval service (no re-chunking)                           | `[decision]`       | T1                 | Yes      | Done    |
| T3  | ADR: degraded signal and partial-failure semantics                                   | `[decision]`       | T1                 | Yes      | Done    |
| T4  | Ingest stores pushed text as-is (no re-chunking)                                     | `[implementation]` | T2                 | —        | Done    |
| T5  | Ingest idempotency on (`source_ref`, content identity)                               | `[implementation]` | T1, T4             | Yes      | Done    |
| T6  | Content invalidation (close the validity window, never delete)                       | `[implementation]` | T1, T4             | Yes      | Done    |
| T7  | Batch ingest + connection pool parameters                                            | `[implementation]` | T5                 | —        | Pending |
| T8  | Degraded envelope with the four set rules                                            | `[implementation]` | T3                 | —        | Done    |
| T9  | Partial-failure semantics, and invalid input vs legal empty                          | `[implementation]` | T8                 | —        | Done    |
| T10 | Graph multi-hop is on by default; a missing address degrades                         | `[implementation]` | T8                 | Yes      | Pending |
| T11 | Rerank on by default; fail-open keeps the mark                                       | `[implementation]` | T8                 | Yes      | Pending |
| T12 | No deterministic pseudo-vectors when credentials are missing                         | `[implementation]` | T8                 | Yes      | Pending |
| T13 | Vector index built in place, with a real dimension guard                             | `[implementation]` | —                  | Yes      | Done    |
| T14 | Precision layer bring-up: CJK segmentation as one arm at both stages                 | `[implementation]` | —                  | Yes      | Pending |
| T15 | Okapi BM25 parameters, phrase queries, and field boosting                            | `[implementation]` | T14                | —        | Pending |
| T16 | Fusion parameters configurable (RRF k, vector / keyword weights)                     | `[implementation]` | —                  | Yes      | Done    |
| T17 | Default configuration enables every capability, asserted hard                        | `[implementation]` | T10, T11, T15, T16 | —        | Pending |
| T18 | Derived indexes rebuild from the authoritative source with no loss and no regression | `[implementation]` | T13, T14           | —        | Pending |
| T19 | Evaluation dataset: real data, format and scale floors, one-command rebuild          | `[implementation]` | T1, T4             | Yes      | Pending |
| T20 | Query-class coverage and gold provenance                                             | `[implementation]` | T19                | —        | Pending |
| T21 | Ablation: eight switches, the full configuration matrix, no silent behaviour change  | `[implementation]` | T1, T16, T17, T20  | —        | Pending |
| T22 | Quantified report: full metric set, percentage deltas, reproducible                  | `[implementation]` | T1, T21            | —        | Pending |
| T23 | Concurrency entry: L1 scenario, idempotent scenario, latency thresholds              | `[implementation]` | T1, T7, T19        | Yes      | Pending |
| T24 | Suite closure, CONTEXT stage refresh, persist flush                                  | `[implementation]` | T17, T18, T22, T23 | —        | Pending |

1. **Cross-repo baseline drift gate** — tag: `[implementation]`
   - **Inherits:** spec SC-39 / §B6 — the two specs' 跨仓对齐基线 sections are byte-identical; take each section body, sha256 it, equal passes, unequal fails. Both file paths are supplied at run time, not hard-coded in the spec.
   - **Surface:** repo-level check entry point (evaluation / cli — location is implementer headroom)
   - **Acceptance:** the check exits 0 while the two sections match and prints both hashes; injecting one byte of drift into either section makes it exit non-zero and print both hashes; the check does not import the MCP server entry.
   - Status: [x] done

2. **ADR: chunking exits the retrieval service (no re-chunking)** — tag: `[decision]`
   - **Inherits:** spec §B4 不二次切分 — "fin 推送的文本即最终文本。检索服务对推送内容不做任何形式的二次切分、截断、重组或归一化改写，按原样存储与召回；召回返回的块文本与推送文本逐字节相同"; C-11 reverses CONTEXT **chunk** ("produced by the chunker during ingest"), **ingest** ("validate → size check → chunk → embed → store") and the relationship row `content → chunker → chunk[]`; reason recorded in the spec: the citation gate requires an answer span to be a contiguous substring of the frozen unit text.
   - **Surface:** `docs/adr/` — the ADR file (0004) is this bullet's outcome; the CONTEXT **chunk** / **ingest** / relationship-table reversal rides along as the same decision.
   - **Acceptance:** the accepted ADR states "no re-chunking, pushed text is final text" with the citation-gate rationale and names fin as the sole chunking authority; the commit touches no product code; CONTEXT no longer describes chunking as an ingest step of iknow-memory.
   - Status: [x] done
   - [parallel] with T3
   - [blocks: T1]

3. **ADR: degraded signal and partial-failure semantics** — tag: `[decision]`
   - **Inherits:** spec §B2 / §B3 — one arm succeeding releases the response with a mark, all arms failing is a typed error, vector-arm failure with no graph hit counts as all-failed; the four set rules (unattemptable default-on capability → set; attempted and failed → set; attempted and found nothing → not set; caller-switched-off → not set); banned silent shapes (deterministic pseudo-vectors, empty results, silent skip, unmarked sequential fallback); field names verbatim `degraded` and `degraded_reasons`.
   - **Surface:** `docs/adr/` — the ADR file (0005) is this bullet's outcome.
   - **Acceptance:** the accepted ADR restates the four set rules and the consumption rule, names the banned silent shapes, and records that missing embedding credentials must not be papered over with deterministic pseudo-vectors; the commit touches no product code; it cites the shared baseline chapter as its source rather than restating different numbers.
   - Status: [x] done
   - [parallel] with T2
   - [blocks: T1]

4. **Ingest stores pushed text as-is (no re-chunking)** — tag: `[implementation]`
   - **Inherits:** spec SC-14; §B4 不二次切分 (quoted in T2); C-11. Chunking is fin's; the ingest path stops carrying a chunking step and no dual path is kept.
   - **Surface:** storage + tools (the `ingest` MCP tool) + the chunking module this retires
   - **Acceptance:** ingesting one content produces exactly one chunk whose text is byte-identical to the input (length and content both asserted); a long single content produces no second chunk, is not truncated, and is not normalized or rewritten; `retrieve` returns that chunk's text byte-identical; `tools/list` is unchanged.
   - Status: [x] done
   - [blocks: T2]

5. **Ingest idempotency on (`source_ref`, content identity)** — tag: `[implementation]`
   - **Inherits:** spec SC-15; §B4 幂等键 — "=（source_ref，内容标识）二元组；内容标识 =（块文本 + 归一化规则版本 + 解析规则版本 + 参数表版本）的确定性哈希。同一幂等键重复推送不产生第二份写入，返回同一批块标识"; §B1 幂等基准 — the same batch pushed the number of times the baseline names: chunk total delta = 0 and the chunk id set is unchanged; a failed push is returned by name and is not counted against the idempotency assertion.
   - **Surface:** storage + tools (the `ingest` MCP tool); idempotency mechanism (lookup-then-insert vs unique constraint) is implementer headroom — a unique constraint touches `chunks` and follows the Ask-first rule from `specs/p0-schema.md`.
   - **Acceptance:** repeating the batch per the baseline produces a chunk row delta of 0 — not one row, not one per repetition — and every call returns the identical chunk id set; content identity follows the pushed text, so text that differs only by a version in the hash component is a different key; SC-46 empty-content push is a typed error with row delta 0 and is excluded from the idempotency count.
   - Status: [x] done
   - [parallel] with T6
   - [blocks: T1, T4]

6. **Content invalidation (close the validity window, never delete)** — tag: `[implementation]`
   - **Inherits:** spec SC-16; §B4 内容失效语义 — "关闭时间有效区间，使该内容不再被任何查询时刻命中；不物理删除；失效幂等、可重复执行，并留下可查询的失效记录"; fin owns the trigger obligation, this repo owns the action and the record; §B4 内容失效触发条件 defines when fin must invalidate.
   - **Surface:** storage + tools (invalidation action on the ingest-side surface — no new MCP tool)
   - **Acceptance:** after invalidating an ingested chunk, `retrieve` at any `valid_at` at or after the invalidation instant returns it 0 times; the row is still present (row count unchanged) and no longer appears in results; repeating the same invalidation request is idempotent; each invalidation leaves a queryable record carrying chunk id, invalidation instant, and triggering party; an unknown `source_ref` is a typed error, not a silent no-op; no physical-delete path is exposed.
   - Status: [x] done
   - [parallel] with T5
   - [blocks: T1, T4]

7. **Batch ingest + connection pool parameters** — tag: `[implementation]`
   - **Inherits:** spec SC-17 (batch limit configurable with a default; at-limit batch succeeds), SC-47 (over-limit is a named overflow typed error, never a silent truncation), SC-18 (pool cap honoured; illegal → `ConfigError`), SC-33 (connection-wait timeout observed as its own failure class, count = 0 during the run). Default values are implementer headroom; the contract only fixes "configurable, > 0, finite, observed".
   - **Surface:** storage (pool) + tools (batch `ingest`) + config
   - **Acceptance:** the configured batch limit is > 0 and finite (0 / missing / non-numeric → typed error); a batch of exactly that many items returns that many chunk ids with an equal row delta; an idempotency-identical batch re-submitted adds 0 rows; a batch over the limit returns a named overflow error distinguishable from "content invalid", exits non-zero, gives both the actual count and the limit, adds 0 rows, and neither truncates nor re-batches the tail; with a pool cap set, the observed concurrent connection count never exceeds it and an illegal cap raises `ConfigError`; a connection-wait-timeout counter exists as an independent failure class.
   - Status: [ ] pending
   - [blocks: T5]

8. **Degraded envelope with the four set rules** — tag: `[implementation]`
   - **Inherits:** spec §B3 — shape is an optional `degraded` boolean plus `degraded_reasons` (a bounded enum list, each entry naming the capability and whether it was unattempted or attempted-and-failed); default-absent means not degraded; the four set rules from T3's ADR; invalid caller input must not set it; SC-9 keeps the success payload's top level to `chunks` plus those two optional keys and nothing else.
   - **Surface:** retrieval envelope + config (capability registry) — one place that decides the flag, not a per-arm copy
   - **Acceptance:** each of the four rules is demonstrated by a test — unattemptable default-on capability sets; attempted-and-failed sets; attempted-with-no-hits does not set; caller-switched-off does not set; every set names the capability in `degraded_reasons`; a success response carries no top-level key beyond `chunks` and the two optional ones; absent `degraded` reads as false and absent `degraded_reasons` reads as empty.
   - Status: [x] done
   - [blocks: T3]

9. **Partial-failure semantics, and invalid input vs legal empty** — tag: `[implementation]`
   - **Inherits:** spec §B2 — one arm succeeding releases the response with a mark; all arms failing is a typed error; vector-arm failure with an empty graph is all-failed; §B2.5 — invalid input (empty query, empty content, empty batch) is a typed error and must **not** set `degraded`, while a legal query that matches nothing is a success with an empty list and must not set `degraded` or throw; SC-9, SC-37, SC-43, SC-48.
   - **Surface:** retrieval assembler + tools input validation
   - **Acceptance:** three constructions all hold — one arm failing while others succeed releases the response, sets `degraded`, names the failed item, and returns only the successful arms' hits; all arms failing returns a typed error that is neither an empty result nor an unmarked partial result; vector-arm failure with no graph hit is treated as all-failed. Empty / whitespace-only query returns a typed error, exits non-zero, returns no empty list and no partial result, does not set `degraded`, and increments an input-validation-failure counter that is > 0. A syntactically legal query with no match exits 0 with an empty list, sets `degraded` 0 times, and is counted 0 times by that same validation counter — and the two cases must differ within the same run.
   - Status: [x] done
   - [blocks: T8]

10. **Graph multi-hop is on by default; a missing address degrades** — tag: `[implementation]`
    - **Inherits:** spec SC-12 — with a graph address configured, a default-configuration `retrieve` goes through the graph arm (seeds → PPR) and the arm is invoked exactly once; with the address missing, a default-on capability could not be attempted, so §B3 rule 1 sets `degraded` and names graph multi-hop in `degraded_reasons`, which supersedes the older "missing URI skips without `degraded`"; graph-priority Host ordering and the fallback-to-vector-plus-precision-layer path are preserved unchanged.
    - **Surface:** retrieval (graph arm) + config
    - **Acceptance:** default configuration with an address configured invokes the graph arm once per `retrieve`; with no address configured the same call sets `degraded` and names the graph item; graph hits still lead the Host order and an empty graph still falls through to vector plus the precision layer without setting `degraded` on that basis alone.
    - Status: [ ] pending
    - [parallel] with T11, T12, T13, T14, T16
    - [blocks: T8]

11. **Rerank on by default; fail-open keeps the mark** — tag: `[implementation]`
    - **Inherits:** spec SC-11 — a default-configuration `retrieve` calls rerank exactly once (injected counter = 1); failure keeps fail-open (pre-rerank order returned, no error thrown at the Host) but **must** set `degraded` and name the rerank item; an unmarked fail-open is a failure; C-3 supersedes "default off / missing token skips without `degraded`".
    - **Surface:** rerank + retrieval assembler
    - **Acceptance:** a default run invokes rerank once; injecting a failing reranker returns the pre-rerank order, throws nothing, and sets `degraded` with the rerank item named; a missing rerank token is the unattempted case and also sets `degraded`.
    - Status: [ ] pending
    - [parallel] with T10, T12, T13, T14, T16
    - [blocks: T8]

12. **No deterministic pseudo-vectors when credentials are missing** — tag: `[implementation]`
    - **Inherits:** spec SC-13 — with embedding credentials absent, the envelope carries `degraded` true and `degraded_reasons` naming vector search, and the result contains no hit computed from a deterministic pseudo-vector; both assertions must hold, not either: an injected embedder shows 0 calls for that `retrieve`, and replaying the same request with the embedder replaced by one that throws a typed error yields the identical hit id sequence with nothing thrown and no empty result masquerading as a hit.
    - **Surface:** embedder + retrieval (vector arm)
    - **Acceptance:** the two SC-13 assertions both pass; the deterministic-pseudo-vector fallback path no longer exists anywhere on the retrieve path; a configured-but-failing embedder is the attempted-and-failed case under §B3 rule 2 rather than a silent substitution.
    - Status: [ ] pending
    - [parallel] with T10, T11, T13, T14, T16
    - [blocks: T8]

13. **Vector index built in place, with a real dimension guard** — tag: `[implementation]`
    - **Inherits:** spec SC-2 — the index exists (introspection finds exactly one), the query plan does not reach the chunk table by sequential scan, the dimension limit is read from config (asserted > 0, finite, actually used in the bound check), the configured dimension is within it, and both a dimension over the limit and an "index cannot be built" condition exit non-zero with a non-empty message instead of skipping silently; all four hold or the criterion fails. Dimension-reduction method, index type, and index parameters are implementer headroom; a dimension change is a one-shot full re-embed, never a mixed-dimension store.
    - **Surface:** storage (vector index) + config
    - **Acceptance:** all four SC-2 checks pass; the limit value comes from configuration and participates in the bound check rather than being a constant; an unbuildable index exits non-zero with a non-empty message (exit 0 = fail); after the change, no code path silently skips index creation.
    - Status: [x] done
    - [parallel] with T10, T11, T12, T14, T16

14. **Precision layer bring-up: CJK segmentation as one arm at both stages** — tag: `[implementation]`
    - **Inherits:** spec SC-1; §Precision layer = CJK segmentation + Okapi BM25 + phrase queries + field boosting delivered as one unit, present at both the entity-finding stage and the fallback stage, complementing **vector search** with no primary/standby switchover; C-1 / C-8 — the earlier Postgres `content_tsv` production shape is superseded, and the new runtime client is a consequence of 定档 B, not an open item; external dependencies unconfigured loud-skip, configured-but-failing sets `degraded` and names the item.
    - **Surface:** retrieval (lexical arm) + storage (derived lexical index) + config; one adapter seam for the whole layer — the structural split is judged by `complexity-anti-drift`, not by numbers copied here
    - **Acceptance:** a CJK query that is not semantically close to the target chunk — per SC-1's three assertions: an anchored sample list of ≥ 3 pairs where cosine(query, target) < cosine(control, target), an absolute ceiling on that cosine, and a non-empty shared-token intersection — returns the target chunk in top-5 with all capabilities on, and the same fixture does not return it with CJK segmentation switched off; the layer's analysis returns ≥ 2 tokens for a continuous CJK string (1 = fail); the layer is queried at both the entity-finding stage and the fallback stage; unconfigured it loud-skips, configured-but-failing at call time it sets `degraded` and names the item; no second lexical ranking implementation is left behind on the authoritative store.
    - Status: [ ] pending
    - [parallel] with T10, T11, T12, T13, T16

15. **Okapi BM25 parameters, phrase queries, and field boosting** — tag: `[implementation]`
    - **Inherits:** spec SC-3 (k1 / b configurable and effective; defaults read from config, > 0 and finite; illegal values → typed error; default values are implementer headroom, not spec content), SC-4 (an exact-phrase match outranks a loose-token-only match inside top-5), SC-5 (changing field weights changes the top-5 id order; a zero-weighted field contributes no hits; negative weights are a config error).
    - **Surface:** retrieval (precision-layer query construction) + config
    - **Acceptance:** changing k1 / b through config changes the top-5 id sequence for the same query on the same corpus; both default to config-sourced values that are > 0 and finite; values ≤ 0, non-numeric, or non-finite raise a typed error; phrase-matched chunks outrank token-only-matched chunks within top-5; changing field weights changes the top-5 id sequence and a zero-weighted field contributes nothing; negative weights are rejected at config load.
    - Status: [ ] pending
    - [blocks: T14]

16. **Fusion parameters configurable (RRF k, vector / keyword weights)** — tag: `[implementation]`
    - **Inherits:** spec SC-8 — RRF k and the vector / keyword weights are changeable through config, the fused result for the same input changes accordingly, nothing throws, and the default k stays 60.
    - **Surface:** config + retrieval (fusion)
    - **Acceptance:** changing k or the weights through config changes the fused order for the same input and throws nothing; a fresh default configuration reads k = 60; illegal values are a config error.
    - Status: [x] done
    - [parallel] with T10, T11, T12, T13, T14

17. **Default configuration enables every capability, asserted hard** — tag: `[implementation]`
    - **Inherits:** spec SC-10 — under a default configuration that supplies only connection addresses and credentials and sets no capability switch, every implemented item in the capability matrix is on and the startup self-check prints a disabled-item list of length 0; a length > 0 makes that check exit non-zero even when all other tests pass; C-4 — the matrix covers this spec's retrieval-stack capabilities and deliberately excludes community topic retrieve and neighbor evidence, which stay default-off and out of both the self-check and the ablation dimensions; the eight switchable keys are fixed verbatim in §B4 and this repo publishes that enum.
    - **Surface:** config + retrieval capability registry + startup self-check
    - **Acceptance:** the self-check reports an empty disabled list on a default configuration and exits non-zero the moment any implemented capability is off; the published capability key enum contains exactly the eight §B4 keys, spelled verbatim, and nothing else; the two excluded post-processing enhancements are absent from the check rather than reported as failures.
    - Status: [ ] pending
    - [blocks: T10, T11, T15, T16]

18. **Derived indexes rebuild from the authoritative source with no loss and no regression** — tag: `[implementation]`
    - **Inherits:** spec SC-6 / SC-7; ADR-0003 — the vector index and the lexical index are derived, deletable, and rebuildable from Postgres, and a rebuild never touches authoritative data; deleting them, rebuilding, and re-measuring must show an unchanged chunk row count (delta 0), run-level P@5 within 0.02 of the pre-rebuild value, and no query going from "had hits" to "no hits".
    - **Surface:** storage (rebuild entry) + cli
    - **Acceptance:** after deleting both derived indexes and running the rebuild entry, the chunk row count equals the pre-rebuild count and authoritative rows are untouched; on a fixed dataset snapshot the post-rebuild run-level P@5 is ≥ pre-rebuild minus the spec's tolerance and no query loses all its hits; the rebuild is repeatable and is the only rebuild entry — there is not one per engine.
    - Status: [ ] pending
    - [blocks: T13, T14]

19. **Evaluation dataset: real data, format and scale floors, one-command rebuild** — tag: `[implementation]`
    - **Inherits:** spec SC-19 (every manifest source entry carries provenance; a missing one is rejected, validator exit non-zero; after import the chunk row count equals the manifest's declared count), SC-20 (format list matches fin's asset list — PDF, Word, PPT, Excel, HTML, Markdown, plain text — with the §B1 per-format floor; shortfall → non-zero exit), SC-22 (source-document / chunk / query floors come from §B1 数据集规模; shortfall → non-zero exit), SC-29 (the frozen gold behind `npm run eval:retrieve` stays untouched and its query-count range check still applies only to its own gold file — the new set coexists, it does not merge), SC-44 (empty corpus: non-zero exit, no baseline written, an existing baseline file's hash unchanged, no all-zero report passed off as success), SC-45 (an empty gold list is a loader typed error, never a "0 hits" score and never a skipped query).
    - **Surface:** evaluation (dataset build + validation) + cli; entry-point location is implementer headroom
    - **Acceptance:** a manifest entry without provenance is rejected with a non-zero exit; after import the chunk row count equals the declared count; the format list and per-format floor match §B1 and fin's asset list; the dataset rebuilds from one command and reproduces from a snapshot id; an empty manifest exits non-zero, writes no baseline, and leaves any existing baseline file byte-identical; a query with an empty gold list terminates the loader with a typed error and writes one failure record per rejected query; `npm run eval:retrieve` still writes its own baseline unchanged.
    - Status: [ ] pending
    - [parallel] with the T10–T16 line-B cluster (fin's phase 1 line C)
    - [blocks: T1, T4]

20. **Query-class coverage and gold provenance** — tag: `[implementation]`
    - **Inherits:** spec SC-21 (four query classes — entity-anchored via the graph, exact-string via phrase, semantic-generalization via vector, temporal carrying `valid_at` — each meeting the §B1 share floor; shortfall → non-zero exit), SC-28 (a gold missing provenance — source document id, judgement method, judgement time, judge model id — is a loader typed error; a judge model id equal to a production extraction or embedding model id is a `ConfigError`), §B1 查询分档 (the CI contract set and the full set, each query class meeting the share floor).
    - **Surface:** evaluation (gold loader + query-set validation)
    - **Acceptance:** all four classes are present and each meets the share floor, otherwise the validator exits non-zero; a query with zero golds is rejected; a gold missing any provenance field is a typed error; a judge model id colliding with a production model id is a config error; the counts come from §B1, not from a second set of numbers in this repo.
    - Status: [ ] pending
    - [blocks: T19]

21. **Ablation: eight switches, the full configuration matrix, no silent behaviour change** — tag: `[implementation]`
    - **Inherits:** spec SC-23 / SC-24; §B1 消融矩阵 (ten configurations = all-on baseline + one per switched-off capability + all-off baseline, each repeated the number of times the baseline names, raw values and median recorded, missing configurations = 0); §B4's eight keys are fixed verbatim (`vector`, `keyword_bm25`, `cjk_segmentation`, `phrase`, `field_boost`, `graph_ppr`, `rrf`, `rerank`) and this repo publishes that enum; SC-23's exhaustive definition of permitted differences — D1 hit set and ordering change, D2 `degraded` set with the switched-off item named, D3 the switched-off item recorded in the report and log — anything outside D1–D3 is a silent behaviour change and fails.
    - **Surface:** evaluation (ablation runner) + config (capability switches)
    - **Acceptance:** each of the eight capabilities can be switched off independently; the run covers all ten configurations with the baseline's repeat count, recording raw values and the median; comparing each single-off run against the all-on baseline yields 0 differences outside D1 / D2 / D3; missing configurations = 0; the published key enum matches §B4 verbatim.
    - Status: [ ] pending
    - [blocks: T1, T16, T17, T20]

22. **Quantified report: full metric set, percentage deltas, reproducible** — tag: `[implementation]`
    - **Inherits:** spec SC-25 / SC-26 / SC-27; §B1 指标集 is the sole authority for the field list — P@5, R@5, Recall@20, nDCG@10, MRR, citation-gate pass rate (produced by fin on the same run and filled at merge; leaving it unfilled counts as a missing field), graph-arm hit rate, error rate, latency p50 / p95 / p99 — every configuration outputs all of them and a configuration missing any one fails; percentages are numbers: (value − baseline) / baseline × 100 to two decimals, baseline's own delta is 0; prose like "noticeably better" in place of a number makes the run exit non-zero; ordering assertion — all-on run-level P@5 ≥ all-off run-level P@5, violation exits non-zero; reproducibility — the same commit, dataset snapshot id, and configuration run twice gives byte-identical run-level P@5 and R@5 (zero float tolerance), with the baseline file written atomically or under an exclusive lock so two concurrent runs cannot tear it.
    - **Surface:** evaluation (report writer) + cli
    - **Acceptance:** a full matrix run emits JSON and Markdown that are git-diffable, carries every §B1 metric field as a finite number per configuration, and prints the percentage delta against the baseline for each; a missing, string-typed, or prose-substituted field exits non-zero; the ordering assertion and the reproducibility assertion both hold; the citation-gate field is accepted as filled-by-fin at merge and flagged as missing if this side never fills it.
    - Status: [ ] pending
    - [blocks: T1, T21]

23. **Concurrency entry: L1 scenario, idempotent scenario, latency thresholds** — tag: `[implementation]`
    - **Inherits:** spec SC-30 – SC-36; §B1 并发 L1 (retrieval / read path, no LLM) and 并发幂等场景 (all-write) supply concurrency, duration, read/write ratio, and total-request floor — taken from the shared baseline, never restated here; §B1 并发 L2 (full run with LLM) is produced by fin on the same run and is not recomputed here; error count = 0 with p50 / p95 / p99 all persisted; latency thresholds per §B1 延迟阈值 (which applies only to L1) with warm-up requests excluded; SC-33 — connection-wait timeout is its own observed failure class and counts 0; SC-34 — ≥ 99% of queries return the same result id set as the serial baseline; SC-35 — within one `retrieve`, the vector, keyword, and graph arms start concurrently rather than waiting in series; SC-36 — the all-write rerun leaves the chunk total delta at 0 with 0 errors.
    - **Surface:** evaluation / cli (concurrency entry) + config; entry-point location is implementer headroom
    - **Acceptance:** the L1 scenario runs at the baseline's concurrency, duration, and read/write ratio, exits non-zero if the total request count falls below the floor, records 0 errors, and persists all three percentiles (any missing percentile exits non-zero); p95 / p99 land under the baseline thresholds with warm-up excluded; the connection-wait-timeout counter exists and reads 0; result-set agreement with the serial baseline meets the §B1 share; the three arms demonstrably start within one call rather than in sequence; the all-write scenario reruns the same batch and ends with a chunk total delta of 0 and 0 errors.
    - Status: [ ] pending
    - [parallel] with T21 / T22 once T19 and T7 have landed
    - [blocks: T1, T7, T19]

24. **Suite closure, CONTEXT stage refresh, persist flush** — tag: `[implementation]`
    - **Inherits:** spec SC-40 / SC-41 / SC-42 — `npm run typecheck`, `npm test`, and `npm run build` all exit 0 (external dependencies unconfigured loud-skip); evaluation and benchmark entries do not import the MCP server entry and the existing isolation test stays green; ADR-0001 holds — every write stays on the authoritative Postgres side or in a derived index, and projection writes still go only through the projection outbox and backfill / drain; plus the 待写入 items owned by T2, T3, and T16.
    - **Surface:** full `npm test` / `npm run build`; `docs/CONTEXT.md` stage lines; the CONTEXT **chunk** / **ingest** reversal and the relationship table
    - **Acceptance:** all three commands exit 0; the isolation test still binds evaluation and benchmark entries away from the server entry; no write path outside the authoritative store, the derived indexes, and the outbox; CONTEXT no longer describes chunking as this repo's ingest step, and the stage lines for the terms this round touched reflect shipped-on-branch; the 待写入 list above is empty; **chunk** and **ingest** entries read "pushed text is final text".
    - Status: [ ] pending
    - [blocks: T17, T18, T22, T23]

## Code review phase (end of round)

After T1–T24 land on the implementation branch: one `arthurpower:code-review` pass on the full diff, then merge. Not per bullet.
