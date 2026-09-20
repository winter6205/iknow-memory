# Plan: contextual wrap at embed

**Goal:** Chunk embed input prepends a non-empty 资料 `title`; stored slice and 资料 bytes stay as pushed; retrieve query embed stays the raw query string.
**Approach:** Lock title-prepend (null/empty = no wrap, not keyed on entity type) in one helper; use it only on ingest and push before `embed`; then prove the query assembler still passes the unwrapped string and MCP gains no instruction field. Sibling specs stay out.
**Spec link:** `specs/contextual-wrap-embed.md`
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — wrap at embed boundary, not a new 资料 type.
input-contract-tests: yes — missing title, present title, empty title treated as absent.
error-handling-enforcer: yes — wrap failure is embed failure (existing embed hard-fail), no silent raw fallback without naming it; this spec keeps current embed hard-fail.
complexity-anti-drift: yes — one wrap helper, two call sites.
minimal-change-verifier: yes — embed input only.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## 待写入

empty — CONTEXT already states wrap; stored-verbatim and query-unwrapped already match.

## Tasks (ordered by dependency)

1. **Title prepend for chunk embed input** — tag: `[implementation]`
   - **Inherits:** spec: when embedding a chunk, if the parent 资料 has a non-empty `title`, prepend that title to the embedder input only; no title → embed slice text as today; empty title treated as absent; wrap does not vary by entity type.
   - **Surface:** wrap helper at the ingest/push embed boundary (`EmbeddingClient.embed(texts)` stays the embed call)
   - **Acceptance:** fixture 资料 title `Acme`, slice `raised funds` → embedder `input` contains title then slice; title null → embedder input equals slice text; empty title ≡ absent; the same slice+title wrap regardless of any entity type on the row.
   - Status: [x] done

2. **Ingest and push wrap before embed; stored bytes unchanged** — tag: `[implementation]`
   - **Inherits:** spec: wrap helper used by ingest and push before `embed`; title from the 资料 row being written; stored chunk `content` and 资料 `content` stay the pushed bytes; wrap failure is embed failure (existing embed hard-fail), no silent raw fallback.
   - **Surface:** ingest / push embed path
   - **Acceptance:** after ingest and after push with titled 资料, `chunks.content` equals `raised funds` and `source_documents.content` is unchanged; wrap failure fails the write the same way embed already fails; two call sites only (ingest and push).
   - `[blocks: T1]`
   - Status: [x] done

3. **Retrieve query stays unwrapped** — tag: `[implementation]`
   - **Inherits:** spec: retrieve query embeddings stay unwrapped; retrieve query embed in assembler; MCP gains no instruction field.
   - **Surface:** retrieve query embed in assembler
   - **Acceptance:** retrieve still calls embed with the raw query string (titled 资料 in the ledger does not wrap the query); ingest/push/retrieve MCP envelopes gain no wrap instruction field; `npx vitest run` on ingest/push/embed suites this change touches exits 0.
   - `[blocks: T2]`
   - Status: [x] done

## End of round

After T1–T3 land: one code-review phase vs `specs/contextual-wrap-embed.md`, then verification-before-completion.
