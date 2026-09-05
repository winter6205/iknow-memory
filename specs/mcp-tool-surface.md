# Spec: MCP tool surface and round boundaries

> **Status:** contract locked for product boundaries; catalog names still Confirm-with-human before implementation.
> **Assumption gate:** confirmed 2026-09-05.
> **Depends on:** `specs/graph-rerank-boot-and-evidence.md` (first slice). This spec is the **second slice**.

## Objective

Freeze what this service will and will not expose this round: expand and tidy the **MCP tool** surface; keep Neo4j a read-only projection; keep chunk text in Postgres; do not put session memory or a Host-side evidence chain in this service.

**Who uses it:** Hosts discovering `tools/list`; implementers adding or archiving tools after the first slice.

**Success looks like:** a reader can tell which product doors are closed; a later plan can name tools without reopening SoR, session memory, or Host citations.

## Glossary

Exact copy from `docs/CONTEXT.md`:

- **iknow-memory**, **MCP tool**, **host**, **chunk**, **triple**, **authoritative source**, **Neo4j sidecar**, **retrieve**, **ingest**

## Confirmed assumptions (gate · 2026-09-05)

1. **Chunks never enter Neo4j.** Postgres holds text; Neo4j projects entities/triples; map back via `source_chunk_id`.
2. **This round expands the MCP tool surface** and may **optimize or archive** existing tools (`echo`, `ingest`, `push`, `invalidation`, `retrieve`). Names should be understandable. Do not avoid a name only because it resembles another product. Still no generation, prompt-assembly, or session tools.
3. **Session memory is not in this service now.** Too complex, low ROI; reopen later if needed.
4. **Neo4j stays a read-only projection**, not a second system of record (ADR-0001).
5. **Host does not add a parallel evidence chain this round.** Evidence lives on `triples.evidence_span` (first slice). Retrieve still returns full **chunk**s. Host reads chunk text for wording; operators read the column for provenance. No second Host citation format.
6. Answer quality, LLM-as-judge totals, and session/long-memory eval are **not** this service's rulers.
7. Exact tool list (what to add, what to archive, final names) is **not** frozen. That is Confirm-with-human before the second-slice plan.

## Boundaries

- **Does:** record the closed doors above so implementation of slice 2 cannot reopen them.
- **Confirms with human:** the concrete catalog — which tools to add, which of `echo` / `ingest` / `push` / `invalidation` / `retrieve` to keep, rename, or archive, and the final names.
- **Out of this spec:** first-slice boot/logs/evidence (`specs/graph-rerank-boot-and-evidence.md`); generation/prompt/session tools; Text2Cypher as a product tool; SQL graph-arm revival; multi-tenant isolation shape; Host map-reduce contract.

## Success Criteria

Binary for the locked doors. Catalog SC stays blocked until Confirm-with-human.

1. No spec, plan, or implementation in this round adds a write path that makes Neo4j authoritative. ADR-0001 remains accepted.
2. No implementation stores **chunk** text as Neo4j node/edge properties. Grep of projection schema / projector remains entity/triple only (`projection_outbox.subject_kind` still `entity`/`triple`).
3. No new MCP tool in this round performs generation, prompt assembly, or session-memory CRUD.
4. `retrieve` success envelope does not grow a Host evidence-chain field this round (no `citations[]` / `evidence_span` on `chunks[]`).
5. After the catalog is confirmed, `tools/list` names match that list and archived tools are absent from the registry. _(Blocked until Confirm-with-human.)_

## Open Questions

1. Exact MCP catalog: add / keep / rename / archive for `echo`, `ingest`, `push`, `invalidation`, `retrieve`, and any new tools.

## Inherits / Changes

**Inherits:**

- ADR-0001 (Postgres SoR, Neo4j read-only projection, chunks out of the graph).
- CONTEXT: context engineering is the **host**'s job; **iknow-memory** returns ranked chunks.
- Current registry in `src/index.ts`: `echo`, `ingest`, `invalidation`, `push`, `retrieve`.
- Evidence column and retrieve envelope: `specs/graph-rerank-boot-and-evidence.md`.

**Changes:**

- Product rule: session memory deferred; Host-side evidence chain deferred; tool names need not dodge other products.
- No CONTEXT term rename required until the catalog is confirmed (then persist tool names if they become domain terms).

## Architecture Change Reviewer

N/A with reason — blast radius and file list are unknown until Open Question 1 is answered. Do not implement slice 2 or write `plans/mcp-tool-surface.md` until the catalog is confirmed and this spec re-runs ACR with ≥3 planned files.

## 待写入 (persist)

- None until the catalog is confirmed. First-slice glossary/ADR is owned by `specs/graph-rerank-boot-and-evidence.md`.

## Hand-off

- Spec path: `specs/mcp-tool-surface.md`
- Implementation plan: **not this turn** (Open Question 1).
