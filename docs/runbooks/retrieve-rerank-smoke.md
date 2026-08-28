# Live retrieve-rerank smoke runbook

**Purpose:** manually verify the temporary `AnthropicChunkReranker` adapter and
the MCP `retrieve` path against an Anthropic-compatible endpoint (the default
is MiniMax M3). This is an operator smoke test, not CI. The normal test suite
uses injected fakes and must not make a live Anthropic request.

## 1. Prerequisites

1. Build the server:

   ```bash
   npm run build
   ```

2. For the adapter-only probe, a reachable Anthropic-compatible endpoint and
   `ANTHROPIC_AUTH_TOKEN` are sufficient.

3. For the retrieve probe, also provide:
   - a reachable Postgres database with the vector schema and at least one
     stored chunk;
   - `GRAPHRAG_MEMORY_STORAGE=pgvector`;
   - embedding dimensions, base URL, model, and an embedding key through the
     embedding env vars documented in `src/config.ts`.

Never put secret values in this runbook or in a commit. Set them in the shell,
`.env.local`, or a host-local secret manager.

## 2. LLM configuration

The reranker uses the extract LLM credential, not the vector/embedding key:

| Env var                                    | Role                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `ANTHROPIC_AUTH_TOKEN`                     | LLM secret used by extraction and retrieve rerank                                    |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`            | Canonical vector/embedding secret                                                    |
| `GRAPHRAG_MEMORY_VECTOR_API_KEY`           | Preferred vector/embedding alias                                                     |
| `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY`        | Legacy vector/embedding alias                                                        |
| `GRAPHRAG_MEMORY_ANTHROPIC_MODEL`          | Optional LLM model; defaults to `MiniMax-M3`                                         |
| `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL`       | Optional Anthropic-compatible base; defaults to `https://api.minimaxi.com/anthropic` |
| `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED` | Explicit rerank gate; set to `true`                                                  |

The three embedding names are ordered as canonical
`GRAPHRAG_MEMORY_EMBED_API_KEY`, preferred alias
`GRAPHRAG_MEMORY_VECTOR_API_KEY`, then legacy alias
`GRAPHRAG_MEMORY_ANTHROPIC_API_KEY`. None is the rerank LLM credential.

For the default MiniMax probe:

```bash
: "${ANTHROPIC_AUTH_TOKEN:?set ANTHROPIC_AUTH_TOKEN in the environment}"
export GRAPHRAG_MEMORY_ANTHROPIC_MODEL="${GRAPHRAG_MEMORY_ANTHROPIC_MODEL:-MiniMax-M3}"
export GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL="${GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL:-https://api.minimaxi.com/anthropic}"
export GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED=true
```

## 3. Adapter-only probe

This calls `AnthropicChunkReranker.permute` directly with two non-secret test
chunks. It should print a JSON object containing the returned IDs, with each
ID present exactly once.

```bash
cat >/tmp/rerank-adapter-probe.mts <<'TS'
import { createAnthropicChunkReranker } from "./src/core/rerank/anthropic-reranker.ts";

const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
if (!apiKey) throw new Error("ANTHROPIC_AUTH_TOKEN is required");
const reranker = createAnthropicChunkReranker({
  apiKey,
  model: process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL ?? "MiniMax-M3",
  baseUrl: process.env.GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL ??
    "https://api.minimaxi.com/anthropic",
});
const ids = await reranker.permute("Which chunk answers the query?", [
  { id: "probe-a", content: "The answer is in the second passage." },
  { id: "probe-b", content: "This passage directly answers the query." },
]);
const valid = ids.length === 2 && new Set(ids).size === 2 &&
  ids.every((id) => id === "probe-a" || id === "probe-b");
console.log(JSON.stringify({ returnedIds: ids, validPermutation: valid }));
if (!valid) process.exitCode = 1;
TS
npx tsx /tmp/rerank-adapter-probe.mts
rm -f /tmp/rerank-adapter-probe.mts
```

The adapter throws on a transport error or a response that is not a JSON array.
The retrieve path catches those failures as described in §5.

## 4. Retrieve probe through the MCP stdio host path

The server must have real retrieval inputs available. Set the Postgres and
embedding variables required by `src/config.ts`, then run this temporary
stdio-host probe from `/workspace`:

```bash
cat >/tmp/retrieve-rerank-probe.ts <<'TS'
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") env[key] = value;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["/workspace/dist/index.js"],
  env,
  stderr: "pipe",
});
const client = new Client(
  { name: "retrieve-rerank-live-probe", version: "0.0.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "retrieve",
    arguments: {
      query: process.env.RETRIEVE_PROBE_QUERY ?? "What does this memory contain?",
      limit: Number(process.env.RETRIEVE_PROBE_LIMIT ?? "5"),
    },
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
TS
npx tsx /tmp/retrieve-rerank-probe.ts
rm -f /tmp/retrieve-rerank-probe.ts
```

Expected output is the normal MCP tool result containing `{ "chunks": [...] }`.
If the LLM fails after retrieval has produced candidates, the same result keeps
the pre-rerank Host order and includes `"degraded": true`; the request still
returns. Do not treat a `degraded` result as a successful rerank.

## 5. Skip and fail-open semantics

- Gate off or unset: with
  `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED` absent/false, retrieve does not
  call the LLM and preserves the existing Host order.
- Gate on without `ANTHROPIC_AUTH_TOKEN`: the adapter is not wired, so rerank
  is skipped. The existing order is returned without `degraded`.
- Gate on with a live adapter: a provider error, timeout, invalid JSON, or
  non-permutation returns the pre-rerank order with `degraded: true`. Retrieve
  does not throw because rerank is fail-open.

## 6. Host `limit` versus rerank window

`limit` is the Host response size. The reranker sees a prefix window
`W = max(limit, candidateCap)`, bounded by the number of candidates actually
returned. The default `candidateCap` is `50`.

- `limit=5` normally asks the LLM to permute up to the first 50 candidates, then
  returns only the best 5.
- `limit=100` makes `W=100`, even with the default candidate cap, so the
  response can still contain 100 chunks when available.
- A short result set reduces the actual request to the available candidates.

The window is a rerank headroom setting, not a replacement for the Host
`limit`; do not expect more than `limit` chunks in the response.

## 7. CI and safety

Do not add a live network call to `npm test`. Existing rerank tests inject the
Anthropic SDK and cover valid permutations, skip behavior, fail-open behavior,
and the window boundary. This runbook is the manual path for a real MiniMax
probe only.
