# Plan: effective config, home directory, and dev/prod compose split

**Goal:** Operators see the effective config layer for every key, processes share one fingerprint function, and the repository compose file no longer collides with production containers.
**Approach:** Split the compose file from the config behavior so those two slices can land together. Config resolution and `show` land before LLM purpose fallback and before fingerprints, because both later slices read the effective config.
**Spec link:** specs/config-effective-show.md
**ACR:** all-yes

affects: `docker-compose.yml` production compose template `.github/workflows/test.yml` `docs/runbooks/local-infra.md` `src/config.ts` `src/config/setting-store.ts` `src/cli/config.ts` `src/index.ts` `src/dashboard-api/main.ts` `src/cli/index-job-worker.ts` `src/core/storage/schema-bootstrap.ts` `src/core/storage/embedding-generation.ts` retrieve response path index-job submit path `tests/config.test.ts` config CLI tests

bounded-context-guardian: yes — config stays in the existing config module and `iknow-memory-config`; compose stays in infra files; generation host guard stays on the embedding-generation singleton; no new bounded context.
input-contract-tests: yes — empty home, invalid protocol, secret masking, unknown `GRAPHRAG_MEMORY_*`, env overriding setting, deprecated cwd `.env.local`, API-key pointer present only in setting.json, same-host path spelling versus a different host, fingerprint unchanged by secrets and by dashboard port.
error-handling-enforcer: yes — unusable known values and an unknown LLM protocol throw `ConfigError` naming the key and not the secret; a missing process report is a named gap; cwd `.env.local` is listed as inactive rather than applied.
complexity-anti-drift: yes — one registry, one effective-config pass, one pure fingerprint function, one CLI printer; LLM fallback is one resolver per purpose; no god function intended.
minimal-change-verifier: yes — one task covering D1, D3, C1, C1-E, C1-X, K1, and the read-only C2 compare. Out of scope: D2, D4, D4-0, G1, G2, Y1, F1–F3, bashrc migration, and the unrelated embedder batch diff on the main worktree.

**待写入:**

- **operator setting** home may be `IKNOW_MEMORY_HOME` (default remains `~/.iknow-memory`).
- **effective config**, **retrieval fingerprint**, **extraction fingerprint** as defined in the spec.

**Per-ticket loop (all bullets):** tdd → typecheck+tests for the suites the slice touches → code-review at the end of the round → (GATE BLOCKED → review-report-repair) → verification-before-completion.

## Tasks (ordered by dependency)

1. **Record the closed product choices** — tag: `[decision]`
   - **Inherits:** spec section "Decisions (this round)".
   - **Surface:** specs/config-effective-show.md
   - **Acceptance:** The spec file states the U1–U8 closures and the out-of-scope list, and this plan's ACR block is all yes.
   - Status: [x] done

2. **Dev compose no longer names production** — tag: `[implementation]`
   - **Inherits:** spec section "Compose". Repository compose is the dev stack; the production template is not applied to running containers.
   - **Surface:** docker compose, the local-infra runbook, the GitHub workflow that starts Elasticsearch from the repository compose.
   - **Acceptance:** Parsing the production template yields external volumes named `iknow-memory-pg`, `iknow-memory-es`, and `iknow-memory-neo4j`, and that template has no `build:` context. The repository compose file contains neither those volume names nor the production container names, and publishes `5433`, `7475`, `7688`, and `9201`. Workflow steps that boot Elasticsearch from that file use `9201` and `iknow-memory-dev-es`. The `test-full` Postgres service stays on `5432`. No container is started or removed.
   - Status: [x] done — production template has no `build:`; dev Neo4j image tag is `iknow-memory-neo4j:5.26.0-gds-2.13.2`; `scripts/wait-for-es.sh` defaults to port 9201. Parse check exit 0.
   - [parallel]

3. **Show the effective layer and honor the home directory** — tag: `[implementation]`
   - **Inherits:** spec sections "Config resolution" and "Registry and show". `loadEnv` remains the only loader. `setting.json` stays a flat string map.
   - **Surface:** src/config, the setting store, `iknow-memory-config`.
   - **Acceptance:** `show` prints value, layer, and effect class; secrets are `configured` or `unset`. An env key that overrides setting.json, an unknown `GRAPHRAG_MEMORY_*` key, and a present cwd `.env.local` are each named as not in effect. `IKNOW_MEMORY_HOME` receives new setting and eval output files. `list` does not print secret values.
   - Status: [x] done — dashboard host/port use the layered read; empty `IKNOW_MEMORY_HOME` and `HOME` throw `ConfigError`; retrieve baseline default write is under the memory home. Targeted vitest exit 0.
   - [parallel]

4. **Split LLM settings by purpose without breaking old keys** — tag: `[implementation]`
   - **Inherits:** spec section "LLM purposes".
   - **Surface:** src/config and the extract, summary, and rerank callers that already read `loadEnv`.
   - **Acceptance:** Purpose-specific keys win when set. When they are absent, boot still succeeds through the existing Anthropic, JEV, and rerank keys. A worker with an empty process env except `HOME` reads an extract key stored only in `setting.json`. `protocol` other than `anthropic` fails with `ConfigError`.
   - Status: [x] done — `loadEnv().llm.*` is what extract, the index worker, community summary, and the dashboard extract lane read. Purpose-key tests and `tsc --noEmit` exit 0. `env -i` process launch is still an end-to-end check, not this slice.
   - [blocks: T3]

5. **Report retrieval and extraction fingerprints** — tag: `[implementation]`
   - **Inherits:** spec sections "Process reports", "Fingerprints and generation", and "Embed freeze check". Changing extract model does not rotate generation or bump the lexical epoch.
   - **Surface:** embedding generation storage, `source_documents` and index-job rows, schema bootstrap column probe, MCP, dashboard, index worker, retrieve response, HTTP rerank health.
   - **Acceptance:** Embed host change is a named startup failure or warning and does not write the current generation; same host and key-only changes are quiet. A new index job stores an extraction fingerprint; a later ingest with another extract model leaves the old row unchanged and the summary says `mixed`. Retrieve returns the retrieval fingerprint, generation id, and epoch. Dashboard port and secret changes do not change the retrieval fingerprint; rerank model and rerank host do, and the rerank URL is not in the output. `show` names a mismatch between a recorded process report and the current process, and names a generation model or dimensions mismatch without writing the singleton.
   - Status: [x] done — host guard, columns, retrieve envelope, and `show` read-only catalog query are in the worktree. `tests/config/show-catalog.test.ts` exit 0. End-to-end worker launch is the interactive check.
   - [blocks: T4]
