# Plan: durable corpus index-job orchestration

**Goal:** A permanent corpus upload can trigger a durable, observable graph-index job, with text-search readiness reported separately from graph and C readiness.
**Approach:** Keep `push` as the text write and search-index operation. Add a durable job handoff that composes the existing extract, projection, Leiden, and community-summary stages, with a persisted submission identity and status readable by fin. The current per-source `source_documents.status` remains the text-push status; `community_index_state` remains the corpus-wide C-ready status.
**Spec link:** T1 creates `specs/corpus-index-job-orchestration.md` and reconciles the existing MCP tool-surface contract before implementation.
**Fin dependency:** [`../../fin/plans/permanent-corpus-upload.md`](../../fin/plans/permanent-corpus-upload.md) owns permanent upload, original-file retention, parsing, and chunking; this plan owns iknow-memory's durable graph-index job trigger and status seam. T1 here and fin upload-plan T1 form the first wave, run in parallel to pin the cross-repo contract, while fin thread-attachment T2a measures resources meanwhile.
**Related, unchanged:** [`bounded-source-read.md`](bounded-source-read.md) is merged and remains the bounded source-read contract; this plan does not change it. [`graph-index-standard-fast.md`](graph-index-standard-fast.md) owns the existing extract and graph-index algorithms.
**ACR:** all five yes for the proposed orchestration boundary; code is blocked on T1's contract decision.

bounded-context-guardian: yes — fin owns permanent-file storage, parsing, and fin-side upload state; iknow-memory owns the corpus index-job ledger and worker boundary; Postgres remains authoritative and Neo4j remains a projection.
input-contract-tests: yes — the decision and implementation tickets cover empty, invalid, overflow, concurrent, and exception classes at submission, lookup, recovery, and worker boundaries.
error-handling-enforcer: yes — submission, persistence, worker, projection, and summary failures require typed outcomes and source-language `EXIT` comments on early exits and fallbacks.
complexity-anti-drift: yes — orchestration composes the existing extract, projection-drain, and community-summary capabilities; it does not copy their algorithms into push or a new god-function.
minimal-change-verifier: yes — scope is the durable host handoff and job lifecycle; PDF parsing, chunking, push semantics, ranking, and graph algorithms stay with their current owners.

**Per-ticket loop (implementation bullets):** tdd → typecheck + targeted tests → verification-before-completion.

## Settled contract and persist list

- `push` stores fin-cut text and makes a source searchable independently of graph extraction. The current `source_documents.status = ready` means the last push succeeded and at least one chunk exists; it does not mean graph extraction or C summaries are ready.
- Graph extraction remains a separate index operation. The MCP `extract` tool is currently synchronous, processes selected pending chunks, and is not a durable job queue. The community-summary runner is a separate CLI entry point.
- C readiness remains global: `community_index_state` describes the whole projected graph and summary generation (`in_progress`, `ready`, `stale`, or `failed`); it is not a per-document flag. C stays unavailable until the complete summary generation is ready, while the text-search and graph arms retain their existing behavior. The upload's source/version job outcome and this global C state are distinct facts whose mapping must be explicit in T1.
- **Persist list:** none settled for this plan yet. `index job` and C readiness already exist in the graph-index contract. T1 must record any newly selected public status vocabulary and ownership terms in the new spec and `docs/CONTEXT.md` before implementation; add or amend an ADR only if T1 changes a durable ownership or lifecycle decision.

## Tasks (ordered by dependency)

1. **Pin the cross-repository job contract** — tag: `[decision]`
   - **Inherits:** [MCP tool-surface contract](../specs/mcp-tool-surface.md): “`extract` runs the existing extract pipeline (LLM triples → merge → persist → outbox), synchronously”; “Not a job queue. Not auto-run inside `ingest` or `push`.” Fin [ADR 0069](../../fin/docs/adr/0069-entity-description-at-extract.md): “Trigger is the index/extract job ... not ingest/push, not query.” [Graph-index spec](../specs/graph-index-standard-fast.md): `community_index_state` is one corpus-level readiness singleton, with `in_progress / ready / stale / failed` states.
   - **Surface:** fin permanent-corpus upload boundary and iknow-memory MCP/index-job boundary.
   - **Acceptance:** Before code starts, both repository plans/specs agree on the trigger that runs after a successful text push while remaining a separate operation; whether a job is bound to one `{document_id, version}` source plus pushed content version or coalesces work across uploads; its idempotency identity, reusing the existing push `(source_ref, content_identity)` key, and re-push behavior; its durable submit/status wire; queued/running/terminal and retry/recovery semantics; typed input, conflict, storage, and stage failures; and how per-source text-ready and source/version job outcomes map separately from corpus-wide graph/C-ready. The decision is recorded in the new iknow spec, the fin upload spec/plan, and the MCP tool-surface contract; any required ADR change is named and written before implementation. The contract includes observable empty, invalid, overflow, concurrent, and exception cases and does not prescribe helper or file names.
   - Status: [ ] pending

2. **Submit and read durable index-job status** — tag: `[implementation]`
   - **Inherits:** T1's approved cross-repository contract; existing push status and global C status remain separate facts.
   - **Surface:** iknow-memory storage, MCP host boundary, and tool registry.
   - **Acceptance:** Given a successfully pushed source, fin can submit the agreed job request and receive a durable identity, then read its persisted state through the agreed host wire. Repeating the same idempotent request resolves to the same job; conflicting identity and unknown or malformed status lookups return typed errors. A real Postgres-backed job remains queryable after the MCP process restarts. Tests exercise empty, invalid, overflow, concurrent duplicate/conflicting requests, and storage exceptions. The MCP conformance path uses a real server/client and PostgreSQL; push remains write-only and a queued job does not falsify `source_documents.status` or `community_index_state`.
   - Status: [ ] pending
   - `[blocks: T1]`

3. **Run the job through existing graph-index stages** — tag: `[implementation]`
   - **Inherits:** T1's approved worker/recovery contract; `plans/graph-index-standard-fast.md` owns extraction methods, projection, Leiden, and summary algorithms; ADR 0069 keeps graph work separate from push.
   - **Surface:** iknow-memory index-job runner, existing extract/projection/community-summary capabilities, persisted job status, and retrieval readiness boundary.
   - **Acceptance:** A durable request runs the selected pending-source extraction and the required projection/graph-summary rebuild through the existing capabilities, then publishes a terminal job state. A worker restart or retried delivery cannot lose the durable request or report success before the required stages finish. Each failed stage has a typed failure and leaves C not-ready; successful full rebuild reports graph/C ready only after the atomic summary swap. Text remains searchable once push is ready even while graph work is queued, running, stale, or failed. Verification uses a committed corpus fixture and records per case the exact `source_ref` and content version, request/idempotency identity, returned job id, observed status transitions, extraction result, terminal outcome, text retrieval result, and C readiness result. Run this gold set against PostgreSQL 16/pgvector and the real MCP process; exercise configured Elasticsearch and Neo4j paths with real services where enabled, including successful C-ready, stage-failure, and worker-restart cases. Existing graph-algorithm tests remain green without live GDS.
   - Status: [ ] pending
   - `[blocks: T1, T2]`

## End of round

After T3 lands, run one code-review phase against the approved fin/iknow contract and this plan, repair any BLOCKED findings, then run verification-before-completion and commit by the repository rule. Do not edit the bounded-source-read plan or fold PDF parsing/chunking into this backend plan.
