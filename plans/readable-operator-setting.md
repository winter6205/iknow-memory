# Plan: readable operator setting

**Goal:** The operator edits one nested `setting.json` where each LLM purpose has its model, provider URL, and api key, and the live file's LLM models are `MiniMax-M3.1-Flash-Preview`.
**Approach:** Teach the existing setting read path to accept that document and project it onto the registry names `loadEnv` already uses. Keep the flat map working. Then rewrite the live file. Do not restart processes.
**Spec link:** specs/readable-operator-setting.md
**ACR:** all-yes

> Contradicts `specs/config-effective-show.md` ("Nested JSON is still rejected"). The operator reopened the document shape on 2026-10-11. YAML stays out of scope. A flat `GRAPHRAG_MEMORY_*` map still loads.

affects: `src/config` setting read path `src/cli/config.ts` `tests` under config `~/.iknow-memory/setting.json` `docs/CONTEXT.md`

bounded-context-guardian: yes — the document stays inside the existing config module and `iknow-memory-config`; no new bounded context; callers keep `loadEnv`.
input-contract-tests: yes — missing file, empty object, unknown field, non-string leaf, mixed flat-and-nested root, `${` that is not a whole-string placeholder, process env overriding a nested value, raw secret masked, unset `${NAME}` leaves the key unset.
error-handling-enforcer: yes — malformed document throws `ConfigError` naming the file or the field path; an unset placeholder does not throw (`// EXIT:` same as an unset `*_API_KEY_ENV` pointer); expanded secrets are not written back to disk.
complexity-anti-drift: yes — one projection from the nested document onto the existing flat map, consumed by the current layered read; `loadEnv` does not grow a second parser; no new god function intended.
minimal-change-verifier: yes — one task, the readable operator document plus the live-file model change. Out of scope: YAML, fin section names, the `https://api.minimax.cn/v1` host, bashrc, Docker, process restarts, re-extract, rotate, and the dirty embedder batch.

**待写入:**

- **operator setting** — the home file may be the nested document in `specs/readable-operator-setting.md`; a flat string map still loads. Flush to `docs/CONTEXT.md` only after the loader accepts the nested file (T2). Do not flush in the planning session: the glossary would describe a shape the current loader rejects.

**Per-ticket loop (all bullets):** tdd → typecheck+tests for the suites the slice touches → code-review at the end of the round → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section).

## Tasks (ordered by dependency)

1. **Record the document the operator confirmed** — tag: `[decision]`
   - **Inherits:** `specs/readable-operator-setting.md` sections "Document" and "Sections".
   - **Surface:** specs/readable-operator-setting.md
   - **Acceptance:** The spec names the nested sections, the registry projection, `${NAME}`, secret masking, and the live-file model `MiniMax-M3.1-Flash-Preview` with the Anthropic base URL left unchanged. This plan's ACR block is all yes.
   - Status: [x] done

2. **Load the nested document as the setting layer** — tag: `[implementation]`
   - **Inherits:** spec sections "Document" and "Sections". Flat maps still load. `loadEnv` stays the only loader. Effect classes stay on the registry names.
   - **Surface:** src/config, `iknow-memory-config`
   - **Acceptance:** A memory home whose `setting.json` is the nested document yields `loadEnv().llm.extract.model`, `.baseUrl`, and `.apiKey` from that document, and the same for summary, rerank, and jev. `show` reports `layer=setting`. A `${NAME}` api key prints the name; a raw api key prints `configured` or `unset`. Process env overrides the file. A flat `GRAPHRAG_MEMORY_*` file still loads. Unknown field, non-string leaf, mixed root, and a broken `${` throw `ConfigError` naming the path. `set` and `unset` leave a nested file nested. An unset `${NAME}` does not throw.
   - Status: [x] done

3. **Rewrite the live setting file and switch the LLM model** — tag: `[implementation]`
   - **Inherits:** spec section "Live file".
   - **Surface:** `~/.iknow-memory/setting.json`
   - **Acceptance:** The live file matches the nested document. `llm.extract`, `llm.summary`, and `llm.rerank` models are `MiniMax-M3.1-Flash-Preview`, their base URL is `https://api.minimaxi.com/anthropic`, and their api key field is `${MINIMAX_API_KEY}`. `jev.apiKey` is `${JEV_API_KEY}`. Embed, database, Elasticsearch, Neo4j, storage, and `pgvector.annMaxDimensions` keep their previous values. A new `show` process prints those three models as `layer=setting` and does not print secrets. MCP, dashboard, the index worker, and containers are not restarted. No re-extract and no rotate.
   - Status: [x] done
   - [blocks: T2]

4. **Flush the operator-setting glossary** — tag: `[decision]`
   - **Inherits:** the 待写入 line in this plan. Run `domain-modeling` for that item only.
   - **Surface:** docs/CONTEXT.md
   - **Acceptance:** The **operator setting** entry describes the nested document and still says a flat string map loads. `_Avoid_` still rejects a second config store.
   - Status: [x] done
   - [blocks: T2]
