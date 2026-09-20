# Spec: embedding generation rotate

## Objective

Make **embedding generation** an operator-visible rotate of stored vectors: when the **operator setting** embed model or dimensions change, rebuild **chunk**, **entity** description, and **community** summary vectors from ledger text as one new generation; **retrieve** query embed and cosine reads use that same generation only.

**Who:** storage / ingest / push / extract persist / community-summary persist / vector retrieve; operator CLI for rotate, cutover, and drop.

**Success looks like:** a model-or-dimension change never shares one cosine index with the previous generation; reads never mix classes across generations; same-model **embedding backfill** still only fills NULLs.

Quoted from `docs/CONTEXT.md` (exact copy, not redefinition):

- **embedding generation**: the model + dimension of stored vectors. Changing either rebuilds chunk, entity-description, and community-summary embeddings from ledger text as a new generation (new column / blue-green then cut over, or a downtime rebuild); query uses that same generation. Same-model backfill of missing rows does not overwrite existing vectors.
- **embedding backfill**: the idempotent NULL-embedding repair mode (CLI flag `--backfill-embeddings`) that embeds and UPDATEs every live entity row `WHERE embedding IS NULL` using the stored description; an immediate second run updates 0 rows. Never runs automatically inside a normal extraction run.
- **operator setting**: the home-directory file `~/.iknow-memory/setting.json` that holds identity and everyday secrets (storage mode, dedicated database URL, embedding model and dimensions, Neo4j URI, API keys). Process env overrides a key when set; missing env does not refuse boot if the file has the key.
- **chunk**: a derived index row for one fin-cut slice of a **资料**: slice text, embedding, ordinal, back-pointer.
- **entity**: a canonical real-world referent extracted from chunks. … Identified by UUID, carries `canonical_name`, `type`, `embedding`, `metadata`.
- **community**: Entity-graph clusters from hierarchical **Leiden** at index time (ADR-0011). Each cluster has a ledger summary …
- **vector search**: cosine similarity over chunk embeddings, served by an index built in place on the existing Postgres vector extension …
- **derived index**: a retrieval index — the vector index and the lexical index — built from the **authoritative source**. Deletable and re-builtable from that source; a rebuild leaves authoritative data untouched and must not regress retrieval quality.
- **authoritative source**: Postgres, holding the sole authoritative copy of **资料** body text and ledger rows (entities, triples, aliases, extraction_records, projection_outbox). **chunk** rows live here as derived index records (ADR-0010).

ADR in scope: **ADR-0003** — vector columns remain a **derived index** on the **authoritative source**; rotation rebuilds vectors from ledger text and must not rewrite **资料** bodies, chunk `content`, entity descriptions, or community summary prose. A later move of the vector index to a dedicated store is out of this spec; this contract stays on the existing Postgres vector columns on `chunks`, `entities`, and `community_summaries`.

## ASSUMPTIONS I'M MAKING

1. Generation identity is the pair (embed model, dimensions). Same width + different model is a new generation and cannot share one cosine index.
2. Physical blue-green is a second vector column (incoming slot) plus its own cosine ANN index on each of the three tables — not in-place CAST, not translating old floats.
3. One ledger singleton records `active` slot, optional `incoming` slot, and the model+dimensions of each. All three classes share that pointer; cutover flips all three together.
4. Desired model/dimensions come from existing **operator setting** / process-env keys already mapped to `loadEnv().embedModel` and `loadEnv().embedDimensions`.
5. If desired ≠ active and no rotate is in progress, `loadEnv`/storage boot is a typed `ConfigError` naming both pairs; it does not DROP the live vector column (today’s `alignEmbeddingDimensions` drop-and-add is retired as the rotation path).
6. Dual-write path: vector **retrieve** and query embed keep using **active** until cutover; ingest/push/extract/community-summary persist write **active** and **incoming** while rotate is open; cutover is refused until every required live vector on all three classes is non-NULL in **incoming** at the new width.
7. Downtime path: same two-slot fill, but vector reads (chunk cosine, entity seed cosine, community-summary cosine) are a typed refuse until cutover; operator must pass an explicit downtime accept flag. Old slot remains until an explicit drop.
8. Ledger text for rebuild: chunk = stored slice text after the existing embed-time title wrap; entity = existing `canonical_name | description` assembler; community = stored `summary` string. Query embed stays unwrapped.
9. **embedding backfill** remains NULL-only on the **active** slot and the **active** model+dimensions; it does not write **incoming**, does not overwrite non-NULL active vectors, and is not a rotate.
10. `community_index_state` (C-ready summary swap) is a different “generation”; this spec does not reuse that singleton for embed slots.
11. Implementation is in scope this wave (not deferred).

→ Parent-locked + session-confirmed.

## Boundaries

- **Does:** ledger singleton + incoming vector columns/indexes on `chunks` / `entities` / `community_summaries`; rotate CLI (dual-write fill from ledger text, optional downtime); atomic cutover of the one active pointer; explicit drop of the inactive slot; boot refuse when desired ≠ active without an open rotate; query and all cosine reads bound to **active** only; persist dual-write while incoming is open; retire drop-column dim align as the product rotate; tests listed below.
- **Confirms with human:** none.
- **Out of this spec:** [retrieve eval suite](retrieve-eval-suite.md); [community level](community-level.md); [search-mode graph global](search-mode-graph-global.md); 资料归档; M4; lexical **derived index** rebuild; moving vectors off Postgres; lazy re-embed inside **retrieve**; translating old vectors; per-class cutover.

## Success Criteria

- Fixture: change model, keep dimensions → incoming column width equals active width; two distinct cosine indexes exist; a retrieve after fill but **before** cutover ranks using only the old slot (query embedded with the old model).
- Fixture: same dimensions, different model → a single shared cosine index over both slots is absent; mixing both slots in one `ORDER BY <=>` is not used.
- Fixture: change dimensions → incoming `vector(N)` is the new N; old floats are not CAST into N; **资料** / chunk `content` / entity description / community `summary` row counts and bytes unchanged.
- Cutover: after incoming is complete, one pointer flip; the next retrieve query embed uses the new model+dimensions; chunk cosine, entity-embedding seeds, and community-summary cosine all read the new slot only.
- Incomplete incoming (e.g. chunks filled, entities not): cutover is a typed refuse; retrieve still uses active only.
- Dual-write ingest: a new **chunk** during an open rotate writes both slots; retrieve still ranks on active until cutover.
- Downtime flag: vector retrieve is a typed named failure until cutover; after cutover it succeeds on the new generation.
- Rollback: after cutover, inactive slot still queryable by an operator rollback (flip pointer back); retrieve then uses the old generation only. Drop CLI removes inactive column+index; a second drop is a no-op.
- **embedding backfill** on a store with non-NULL active vectors and desired == active: updates 0 rows; does not copy into incoming.
- Boot with desired ≠ active and no rotate row: typed `ConfigError`; catalog still has the old vector column (no DROP COLUMN).
- Concurrent second rotate while one is open: typed refuse.
- `npx vitest run` on suites this change touches exits 0.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** `chunks.embedding`, `entities.embedding`, `community_summaries.embedding` as Postgres vector columns with cosine ANN; `loadEnv` embed model/dimensions; **operator setting** file; ingest/push embed path; extract `--backfill-embeddings`; community-summary persist embed; query embed in retrieve assembler; typed codes `EMBEDDING_DIM_MISMATCH` / `EMBEDDING_FAILED`; ADR-0003 rebuild-from-source; [contextual wrap](contextual-wrap-embed.md) for chunk embed input.

**Changes:** generation singleton; incoming slot + dual-write / downtime rotate + cutover + drop; bind all cosine reads and query embed to **active**; stop using drop-column dim realign as rotate.

**待写入:** none (`embedding generation` / **embedding backfill** already match).

## Architecture Change Reviewer

affects: `src/core/storage/schema-bootstrap.ts` `src/core/storage/embed-dim-align.ts` `src/core/storage/pgvector-backend.ts` `src/cli/` (rotate/cutover/drop) ingest/push/extract/community-summary persist + retrieve query-embed bind + tests under `tests/storage/` and CLI.

bounded-context-guardian: yes — ledger vector slots + operator rotate stay in storage/CLI; no host prompt assembly, no new MCP tool.
input-contract-tests: yes — desired≠active empty rotate, invalid/overflow dimensions vs ANN max, concurrent second rotate, embed exception mid-fill (incoming incomplete, active intact).
error-handling-enforcer: yes — typed `ConfigError` and existing embed/storage error codes on mismatch, incomplete cutover, downtime-read, embed fail; no silent DROP; no mixed-generation cosine; // EXIT on refuse-cutover and boot-mismatch.
complexity-anti-drift: yes — orchestrator (open rotate / fill three classes / cutover / drop) plus per-table slot helpers; no god-file that inlines SQL for three tables in one function.
minimal-change-verifier: yes — one task (embedding generation rotate); not eval suite, community-level cap, search_mode tokens, 资料归档, or M4.
