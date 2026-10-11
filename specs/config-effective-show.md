# Spec: effective config, home directory, and dev/prod compose split

## Objective

An operator can see each config key's effective value and the layer that supplied it, and can see settings that were written but are not in effect. Secrets show only whether they are configured. The repository compose file can run beside the already-running production containers without sharing their volumes, container names, or host ports.

## Decisions (this round)

Product choices marked for operator approval in `docs/iknow-config-requirements.md` are closed as follows. Do not reopen them in code.

- No YAML config (U1). `setting.json` stays the operator file.
- LLM settings split by purpose: extract, summary, rerank (U2), with a backward-compatible fallback onto the keys that exist today.
- Extract credentials resolve from iknow's own settings (U3). Do not read `FIN_API_KEY`.
- Do not rewrite `~/.bashrc` and do not copy live secrets into `setting.json` (U4). A key-name pointer resolves against process env and against the same name in `setting.json`, so a non-interactive process with only `HOME` can see a key that the file holds.
- Docker data stays on named volumes (U5). No bind-mount migration.
- Do not recreate running containers, do not backup or stop them (U6 / D2).
- Do not delete leftover volumes or containers (U7 / D4).
- Do not mount unread old volumes (U8 / D4-0).
- Community-summary fingerprint (G2), full graph re-extract (G1), and fin `dev-up` / w-forge (F1–F3) are out of this repository change.

## Terms

Quoted from `docs/CONTEXT.md`:

- **operator setting**: the home-directory file `~/.iknow-memory/setting.json` that holds identity and everyday secrets. Process env overrides a key when set; missing env does not refuse boot if the file has the key. The CLI is `iknow-memory-config`, not a subcommand of `iknow-memory`.
- **embedding generation**: the model + dimension of stored vectors. Changing either rebuilds vectors as a new generation. Same-model backfill does not overwrite existing vectors.
- **资料**: the source document body in Postgres.

This spec adds:

- **effective config**: the value a process actually uses for one key, plus the layer that won (`env`, `setting`, `home-env-file`, or `default`).
- **retrieval fingerprint**: a stable id of the retrieve path (generation id, lexical epoch, tokenizer and mapping fingerprint, selected rerank adapter and model, default search mode, neighbor evidence). Dashboard port and secret values are not inputs. A base URL contributes only a normalized hostname hash, and the URL itself is not emitted.
- **extraction fingerprint**: protocol + model + normalized hostname hash of the extract LLM. It is required on new index-job rows and on the 资料 version those jobs index. Changing it does not rotate embedding generation and does not bump the lexical epoch.

## Config resolution

Every process that already calls `loadEnv()` keeps doing so. No second loader.

Precedence for one known key:

1. Non-blank `process.env`.
2. `setting.json` under the home directory.
3. `.env.local` under the home directory.
4. The documented default.

A blank env value does not shadow the file. `cwd/.env.local` is never applied. When that file exists, `show` names it as a deprecated source that is not in effect.

Home directory: `IKNOW_MEMORY_HOME` when set, otherwise `~/.iknow-memory`. `setting.json`, the home `.env.local`, eval outputs that previously defaulted to a relative `gold-set/` write, and process fingerprint reports live under that directory. The committed fixture `gold-set/snapshot.json` stays in the repository. Setting `IKNOW_MEMORY_HOME` to a temporary directory must not create new files in the repository working tree.

`setting.json` remains a flat string map of `GRAPHRAG_MEMORY_*` keys. Nested JSON is still rejected.

### Registry and show

Known keys are described by one zod registry: secret or not, effect class (`restart`, `rotate`, or `next-extraction`), and the env name. `loadEnv` still fails startup with `ConfigError` when a known key's value is unusable. An unknown `GRAPHRAG_MEMORY_*` key in env or in `setting.json` does not fail startup; `show` names it.

`iknow-memory-config show` prints effective config with no secret values. Each known key shows its effective value (or `configured` / `unset` for secrets), the winning layer, and the effect class. It also lists, one entry each:

- setting keys overridden by env
- unknown keys
- a present `cwd/.env.local`

`list` masks secrets the same way. `get` of a secret prints `configured` or the existing absent exit, never the value.

Every key requires a process restart to take effect. The registry additionally marks embed model, embed dimensions, and embed host as `rotate`, and extract model and summary model as `next-extraction`.

### LLM purposes

Logical view on the loaded env: `llm.extract`, `llm.summary`, `llm.rerank`. Each has `protocol` (only `anthropic` this round), `model`, `baseUrl`, and an API-key pointer. An unknown protocol is `ConfigError`.

Flat keys (new, optional):

- `GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL|MODEL|BASE_URL|API_KEY_ENV`
- `GRAPHRAG_MEMORY_LLM_SUMMARY_PROTOCOL|MODEL|BASE_URL|API_KEY_ENV`
- `GRAPHRAG_MEMORY_LLM_RERANK_PROTOCOL|MODEL|BASE_URL|API_KEY_ENV`

Fallback when the purpose block is absent: extract uses today's Anthropic / JEV keys; summary uses the extract result; rerank uses today's rerank URL or Anthropic rerank block. Old settings keep booting.

`*_API_KEY_ENV` is a key name. Resolve it from process env, then from `setting.json` under that same name. A worker started with `env -i HOME=$HOME` can read an extract key that lives only in `setting.json`.

### Process reports

MCP, dashboard, and the index worker compute fingerprints with the same function `show` uses. MCP and dashboard write a report under the home directory. The worker writes the same report and stores the extraction fingerprint on the index-job row. `show` compares those reports with the fingerprint of the current process and names each mismatch. A missing report is a named gap, not a match.

## Fingerprints and generation

`describeEffectiveConfig()` is the single summary used by `show` and by the startup report.

Retrieval fingerprint inputs are the PG embedding-generation singleton id, the lexical epoch, the tokenizer and mapping fingerprint, the rerank adapter actually selected (`llm` or `http`), that adapter's model, the default search mode, and neighbor evidence. Extraction fingerprint inputs are extract protocol, model, and hostname hash.

`retrieve` returns the process retrieval fingerprint plus generation id and epoch.

HTTP rerank health includes the sidecar's model id when the HTTP adapter is selected. That model id participates in the retrieval fingerprint. The URL does not.

Changing only the dashboard port leaves the retrieval fingerprint unchanged. Changing the rerank model changes the retrieval fingerprint and not the extraction fingerprint. Changing only a secret changes neither. Changing the extract model changes the extraction fingerprint, does not change the retrieval fingerprint, does not auto re-extract, and does not open an embedding rotate or bump the lexical epoch.

### Embed host guard

The generation singleton stores a hash of the normalized embed hostname. Startup compares it with the effective embed host. A different host, with no rotate open, is a named `ConfigError` or a named warning that refuses to write vectors into the current generation. Changing only the API key, or spelling the same host with a different path, does not trip the guard. The hostname is not printed.

### Rows

New index-job rows and the 资料 version they index require an extraction fingerprint. Existing rows may stay null. K1 grouping counts sources by that fingerprint and marks `mixed` when two or more groups exist. That count is part of the config summary.

### Embed freeze check

`show` can compare the singleton's model and dimensions with the effective embed model and dimensions. Mismatch is named. This command does not mutate the singleton and does not freeze or unfreeze anything by itself.

## Closed by the current code

- `IKNOW_MEMORY_HOME` is the directory that directly contains `setting.json` and the home `.env.local`. It does not get another `.iknow-memory` segment appended. Unset means `~/.iknow-memory`. An empty home with neither variable set is `ConfigError`, not a write under `/.iknow-memory`.
- Dashboard host and port use the same precedence as every other key. They are effect class `restart`. They are not inputs to either fingerprint.
- Extract and the index worker today read `ANTHROPIC_AUTH_TOKEN` from `process.env` only (`src/core/extraction/clients.ts`). Purpose fallback must replace that direct read. `loadEnv` does not call `resolveSettingValue`; one read path is enough.
- The 资料 version that stores the extraction fingerprint is `source_documents`, not structured `source_versions`.
- There is no lexical-epoch column. The lexical epoch and the tokenizer/mapping fingerprint are hashes of the Elasticsearch analyzer and mapping contract already in the precision layer. Do not add a counter. Changing the extract model must not write that hash.
- A new column on an existing table is invisible to old databases unless `schema-lock.ts` names it beside the `ADD COLUMN`.
- HTTP rerank has no health client. The retrieval fingerprint reads the sidecar model with `GET {origin}/health` and JSON `{ "model": "<id>" }`, where origin comes from the rerank URL. The URL is not hashed and not printed. If health does not answer, the model slot is the token `unresolved` and `show` names that gap. Retrieve still starts.
- `list` and `get` currently print secret values. Masking them is the change, including the tests that expect the raw value.

## Compose

Repository `docker-compose.yml` is the dev stack:

- project name `iknow-memory-dev`
- container names `iknow-memory-dev-postgres`, `iknow-memory-dev-neo4j`, `iknow-memory-dev-es`
- host ports `5433`, `7475`, `7688`, `9201`
- its own named volumes, not `external`, not the production volume names

A production compose template lives in the repo and is the file an operator copies to `~/.iknow-memory/compose/`. It is not applied by this change. Neo4j and Elasticsearch are `image:` references to the existing tags (`iknow-memory-neo4j:5.26.0-gds-2.13.2`, `iknow-memory-elasticsearch:8.19.20`) with no `build:` context, so the copied file does not need the repository tree.

- project name `iknow-memory`
- container names unchanged: `iknow-memory-postgres`, `iknow-memory-neo4j`, `iknow-memory-es`
- host ports unchanged: `5432`, `7474`, `7687`, `9200`
- volumes `external: true` with names `iknow-memory-pg`, `iknow-memory-es`, `iknow-memory-neo4j`

Parsing that template yields exactly those three volume names. Running the repository compose file does not reference those names.

GitHub Actions jobs that start Elasticsearch from the repository compose use port `9201` and the dev container name `iknow-memory-dev-es` in `docker inspect` / `docker logs`. The workflow Postgres service in `test-full` stays on `5432`; it is not the compose Postgres. `scripts/wait-for-es.sh` default URL follows the repository compose port. Tests and docs that talk to the already-running production containers stay on `5432` and `9200`. Do not start, stop, or recreate containers in this change.

## Out of scope

D2, D4, D4-0, G1, G2, Y1, F1, F2, F3. No edit to the unrelated embedder batch work on the main working tree.

## Success criteria

- `show` lists effective value, layer, and effect class; secrets are `configured` or `unset`.
- Overridden setting keys, unknown `GRAPHRAG_MEMORY_*` keys, and a present `cwd/.env.local` each appear as not in effect.
- `IKNOW_MEMORY_HOME` redirects new setting and eval output files.
- Purpose-specific LLM keys win; absent purpose keys still boot through the old Anthropic / JEV / rerank keys.
- An extract key stored only in `setting.json` is visible to a worker whose process env is empty except `HOME`.
- Embed host change is refused or warned by name; same host and key-only changes are not.
- A new index job carries an extraction fingerprint; a second extract model on a later ingest does not rewrite the older row, does not change generation or epoch, and the summary reports `mixed`.
- Retrieval fingerprint ignores dashboard port and secrets, changes when the rerank model or rerank host changes, and is returned on retrieve. Rerank URL text is absent from the fingerprint output.
- Production template volume names parse as specified. Repository compose uses the dev names and ports above.
- Suites this change touches exit 0. A full-repo run is not required for every edit.
