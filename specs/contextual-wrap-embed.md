# Spec: contextual wrap at embed

## Objective

When embedding a **chunk**, if the parent **资料** has a non-empty `title`, prepend that title to the embedder input only. Stored chunk `content` and 资料 `content` stay the pushed bytes. Retrieve query embeddings stay unwrapped. Wrap does not vary by entity type. Empty / whitespace-only title is treated as absent.

**Who:** ingest / push embed path.

**Success looks like:** identical stored slice text; different vectors when title is present vs absent for the same slice.

## Boundaries

- **Does:** wrap helper used by ingest and push before `embed`; title from the 资料 row being written; no title → embed slice text as today; query embed unchanged; MCP gains no instruction field; wrap not keyed on entity type.
- **Confirms with human:** none.
- **Out of this spec:** [entity type and filter](entity-type-and-filter.md); [extract verify](extract-verify.md); [merge gray zone](merge-gray-zone-judge.md); [retrieve judge rerank](retrieve-judge-rerank.md).

## Success Criteria

- Fixture: 资料 title `Acme`, slice `raised funds` → embedder `input` contains title then slice; `chunks.content` equals `raised funds`; `source_documents.content` unchanged.
- Fixture: title null → embedder input equals slice text.
- Retrieve query path still calls embed with the raw query string.
- `npx vitest run` on ingest/push/embed suites this change touches exits 0.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** 资料 `title` column; ingest/push envelope; `EmbeddingClient.embed(texts)`; retrieve query embed in assembler.

**Changes:** embed-time wrap on chunk document side only.

**待写入:** CONTEXT already states wrap; keep stored-verbatim / query-unwrapped as the contract after this lands.

## Architecture Change Reviewer

bounded-context-guardian: yes — wrap at embed boundary, not a new 资料 type.
input-contract-tests: yes — missing title, present title, empty title treated as absent.
error-handling-enforcer: yes — wrap failure is embed failure (existing embed hard-fail), no silent raw fallback without naming it; this spec keeps current embed hard-fail.
complexity-anti-drift: yes — one wrap helper, two call sites.
minimal-change-verifier: yes — embed input only.
