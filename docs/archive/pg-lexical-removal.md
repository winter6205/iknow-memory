# Archived: Postgres lexical arm — implementation notes

> **Archived:** 2026-09-03.
> **Superseded by:** Elasticsearch precision layer (`src/core/storage/elasticsearch-precision.ts`).
> **Plan context:** `plans/es-precision-layer.md` T7 (Postgres 词法臂摘除 / expand→migrate→contract 的 contract 步).

This file records the implementation shape of the Postgres lexical arm
that previously sat between the chunk ledger and `retrieve`. It is preserved
for traceability — the live code path is gone, and `docs/CONTEXT.md` treats
the Elasticsearch precision layer as the sole production lexical carrier.

## What the old shape looked like

A Postgres-only lexical arm that delivered the `bm25` leg of vector+BM25 RRF
without an external service:

- **Generated tsvector column.** `chunks` carried a `content_tsv`
  `tsvector` column maintained by a Postgres `GENERATED ALWAYS AS ...`
  expression over `content`, with the desired text-search configuration
  applied at the column level (preferred: built-in `simple` config — the
  default Postgres choice that is intentionally locale-agnostic and
  preserves no stopwords, so it round-trips Chinese / mixed-language text
  without losing characters to a stopword list).
- **GIN index.** A `USING GIN (content_tsv)` index on `chunks` backed the
  lexical lookup. DDL and index creation lived alongside the rest of the
  schema-p0 helpers.
- **Ranking function.** `ts_rank_cd` (cover-density variant, chosen for
  term-proximity awareness over plain `ts_rank`) ordered the candidate
  set. Okapi k1 / b were _not_ expressible directly under the built-in
  config; the spec accepted that and treated the Postgres path as a
  reasonable approximation suitable for the `simple`-config regime.
- **Predicate.** `LEXICAL_TSQUERY` was the named helper that produced the
  `to_tsquery('simple', …)` value, taking the user query and producing a
  query shape the index could consume; it was the single funnel for any
  caller hitting the lexical arm.
- **Configuration.** No env knobs of its own — the arm inherited the
  `RetrieveConfig` enable/weight pair (`bm25Enabled`, `w_bm25`) and ran
  whenever those were on; the index itself required no per-environment
  tuning.

## Why it was removed

The `simple` config cannot segment Chinese. A continuous CJK string tokenized
under `simple` collapses to one or two over-broad tokens, so a Chinese query
sharing only character-level overlap with a Chinese chunk almost never
matches. Real Chinese lexical recall needed a tokenizer that was never going
to land in the Postgres built-in configs, and adding a Postgres-side
extension would have re-hardcoded a single implementation choice into the
database. The retrieval-stack C-1 decision moved the lexical arm out of
Postgres and onto the Elasticsearch precision layer (CJK segmentation,
real Okapi BM25 with configurable k1 / b, phrase queries, field boosting)
so the four lexical capabilities sit on the same analyzer and the same
token stream. Postgres keeps no second lexical ranking implementation.

## What replaced it (live code now)

- `src/core/storage/elasticsearch-precision.ts` —
  `ElasticsearchPrecisionLayer` plus the `chunkMappings()` /
  `entityMappings()` mapping definitions and the `ik_index` / `ik_query`
  analyzer wiring.
- `src/config.ts` — `ELASTICSEARCH_*` env block and the derived
  `ElasticsearchConfig` interface (`ElasticsearchConfig`).
- `src/core/retrieval/optional-arms.ts` and
  `src/core/retrieval/index.ts` — the lexical arm now resolves through the
  precision-layer seam; the `keyword_bm25` capability is observed at the
  envelope when it was attempted and failed.
- `docs/runbooks/es-precision-layer.md` — operator-side deployment,
  plugin install, mapping / rebuild / recover steps.

## Guardrails (still in force)

- `ts_rank_cd` / `LEXICAL_TSQUERY` / `content_tsv` / `to_tsvector` /
  `to_tsquery` / `tsvector` (in the lexical-arm sense) full-repo greps
  must be zero in active `src/` / `tests/` paths. The `docs/archive/`
  copy of this note and the archived `specs/bm25-retrieve.md` are the
  only places those literals legitimately remain.
- The Postgres ledger (`entities`, `entity_aliases`, `triples`,
  `extraction_records`, `chunks`) is **untouched** by the removal — only
  the lexical column / index on `chunks` was migrated out.

## Reversing this

Reversing would mean re-introducing a second lexical ranking shape
(Postgres `tsvector` plus ES precision layer both active), which the spec
forbids ("Postgres keeps no second lexical ranking implementation"). If
the precision layer needs to be retracted, the route is
`plans/es-precision-layer.md` reversal — not a Postgres re-introduction.
