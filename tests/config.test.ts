import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ConfigError, loadEnv } from "../src/config.ts";

/**
 * Config contract — stage 0 is stdio-only.
 *
 * Why these tests exist: prior to this commit, `loadEnv()` returned a
 * `transport` field backed by a single-member type and a no-op ternary
 * (`rawTransport === "stdio" ? "stdio" : "stdio"`). The dead code
 * pretended the server honored a non-stdio value while silently coercing
 * every input to "stdio". The host wiring (`.mcp.json`) and the
 * `main()` guard (`index.ts:111-116`) both relied on the lie. This test
 * locks the post-fix shape: `loadEnv` returns ONLY `{ logLevel }`;
 * `GRAPHRAG_MEMORY_TRANSPORT` is ignored, and the server's transport
 * choice is hard-coded to stdio at the call site.
 *
 * What is NOT covered here (deferred to #36 alongside typed errors and
 * IO-throwing handlers per
 * `docs/handoff/2026-07-29-graphrag-mcp-host-acceptance.md`):
 *   - concurrent `loadEnv()` under env mutation (no shared cache, but
 *     also no current use case)
 *   - parseEnvFile read-throw paths (.env.local fallback; stage 0 has
 *     no .env.local shipped)
 */
/**
 * The GRAPHRAG_MEMORY_RETRIEVAL_* family. Every describe block below
 * scrubs all of them so a developer's real values can neither trip the
 * boundary validation nor leak into a default assertion.
 */
const RETRIEVAL_VARS = [
  "GRAPHRAG_MEMORY_RETRIEVAL_RRF_K",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_VEC",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_BM25",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_NODE_EMBEDDING_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
  "GRAPHRAG_MEMORY_RETRIEVAL_PRESET",
  "GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K",
  "GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR",
] as const;

const PGVECTOR_VARS = ["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] as const;

/**
 * Extract Anthropic trio reused as the temporary rerank adapter.
 * Scrubbed so a developer machine with extract credentials cannot turn
 * a "skip" assertion into a configured rerank block.
 */
const ANTHROPIC_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_MODEL",
  "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL",
] as const;

/**
 * The GRAPHRAG_MEMORY_NEO4J_* family (#70 T1). Scrubbed wherever the
 * Neo4j block is under assertion so an operator's live sidecar
 * credentials cannot turn a "not configured" case into a configured one.
 */
const NEO4J_VARS = [
  "GRAPHRAG_MEMORY_NEO4J_URI",
  "GRAPHRAG_MEMORY_NEO4J_USER",
  "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
] as const;

describe("loadEnv — stage 0 stdio-only contract", () => {
  // GRAPHRAG_MEMORY_EMBED_DIMENSIONS is now always required; scrub
  // NINE_ROUTER_KEY (and the now-coupled BASE_URL/MODEL fields) for the
  // whole block so a developer machine with a real key doesn't trip the
  // key-coupled required-fields check. Set a default dimensions so the
  // always-required check passes.
  const SCRUBBED: readonly string[] = [
    "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
    "GRAPHRAG_MEMORY_EMBED_BASE_URL",
    "GRAPHRAG_MEMORY_EMBED_MODEL",
    "GRAPHRAG_MEMORY_EMBED_API_KEY",
    "GRAPHRAG_MEMORY_VECTOR_API_KEY",
    "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
    "NINE_ROUTER_KEY",
    // Retrieval pipeline knobs (spec-3 T5) — scrub so a developer's real
    // values don't trip the boundary validation or leak into assertions.
    ...RETRIEVAL_VARS,
    ...PGVECTOR_VARS,
    ...NEO4J_VARS,
    ...ANTHROPIC_VARS,
  ];
  const saved = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const k of SCRUBBED) {
      saved.set(k, process.env[k]);
      process.env[k] = "";
    }
    process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
    process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_RRF_K"] = "60";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_VEC"] = "0.7";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_BM25"] = "0.15";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH"] = "0.15";
  });
  afterAll(() => {
    for (const k of SCRUBBED) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns the stage 1 field set with no transport field", () => {
    const env = loadEnv();
    expect(Object.keys(env).sort()).toEqual([
      "dbUrl",
      "embedApiKey",
      "embedBaseUrl",
      "embedDimensions",
      "embedModel",
      "logLevel",
      "neo4j",
      "pgvectorAnnMaxDimensions",
      "rerank",
      "rerankUrl",
      "retrieval",
      "storage",
    ]);
    expect(env).not.toHaveProperty("transport");
  });

  it("defaults logLevel to 'info' when no env var is set", () => {
    const prev = process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
    delete process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
    try {
      expect(loadEnv().logLevel).toBe("info");
    } finally {
      if (prev !== undefined) process.env["GRAPHRAG_MEMORY_LOG_LEVEL"] = prev;
    }
  });

  it("accepts each valid logLevel verbatim", () => {
    const prev = process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
    for (const lvl of ["debug", "info", "warn", "error"] as const) {
      process.env["GRAPHRAG_MEMORY_LOG_LEVEL"] = lvl;
      expect(loadEnv().logLevel).toBe(lvl);
    }
    if (prev !== undefined) process.env["GRAPHRAG_MEMORY_LOG_LEVEL"] = prev;
    else delete process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
  });

  it("ignores GRAPHRAG_MEMORY_TRANSPORT (stage 0 is stdio-only)", () => {
    // Regression guard for the dead-branch bug: even when an operator
    // (or a stray .mcp.json) sets GRAPHRAG_MEMORY_TRANSPORT=http, the
    // server's behavior must not depend on the value.
    const prev = process.env["GRAPHRAG_MEMORY_TRANSPORT"];
    process.env["GRAPHRAG_MEMORY_TRANSPORT"] = "http";
    try {
      const env = loadEnv();
      expect(env).not.toHaveProperty("transport");
      expect(env.logLevel).toBeDefined();
    } finally {
      if (prev !== undefined) process.env["GRAPHRAG_MEMORY_TRANSPORT"] = prev;
      else delete process.env["GRAPHRAG_MEMORY_TRANSPORT"];
    }
  });
});

/**
 * Stage 1 (T7) config contract — storage mode + embedding provider.
 *
 * Why these live in their own describe: they mutate a different env-var
 * family than the stage 0 block, and every case must restore the prior
 * value so tests stay order-independent (vitest shares one process per
 * file).
 */
const STAGE1_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "NINE_ROUTER_KEY",
] as const;

/**
 * `readEnv` falls through to `.env.local` when a process key is missing.
 * Blanking beats the file; `delete` does not. Host-smoke hit the same
 * seam (T-007).
 */
function maskDotenvLocal(keys: readonly string[]): void {
  for (const k of keys) process.env[k] = "";
}

function withIsolatedEnv(
  keys: readonly string[],
  patch: Record<string, string | undefined>,
  fn: () => void
): void {
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
  }
  maskDotenvLocal(keys);
  for (const [k, v] of Object.entries(patch)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    process.env[k] = v === undefined ? "" : v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const DOTENV_MASK_KEYS = [
  ...STAGE1_KEYS,
  ...RETRIEVAL_VARS,
  ...PGVECTOR_VARS,
  ...NEO4J_VARS,
] as const;

/**
 * Run `fn` with STAGE1_KEYS cleared, then patched by `patch`.
 * GRAPHRAG_MEMORY_EMBED_DIMENSIONS defaults to "1536" so existing tests
 * that don't care about dimensions don't need to set it explicitly.
 */
function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  withIsolatedEnv(
    DOTENV_MASK_KEYS,
    {
      GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
      GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
      GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: "60",
      GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "0.7",
      GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: "0.15",
      GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0.15",
      ...patch,
    },
    fn
  );
}

describe("loadEnv — stage 1 storage + embedding contract", () => {
  it("defaults storage to 'memory' with no dbUrl", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.storage).toBe("memory");
      expect(env.dbUrl).toBeUndefined();
    });
  });

  it("leaves embedBaseUrl and embedModel undefined when no apiKey is set", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.embedBaseUrl).toBeUndefined();
      expect(env.embedModel).toBeUndefined();
    });
  });

  it("overrides embedBaseUrl and embedModel from env", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid",
        GRAPHRAG_MEMORY_EMBED_MODEL: "custom-embed-model",
      },
      () => {
        const env = loadEnv();
        expect(env.embedBaseUrl).toBe("https://example.invalid");
        expect(env.embedModel).toBe("custom-embed-model");
      }
    );
  });

  it("strips a trailing slash from embedBaseUrl", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1/",
        GRAPHRAG_MEMORY_EMBED_MODEL: "test-model",
      },
      () => {
        expect(loadEnv().embedBaseUrl).toBe("https://example.invalid/v1");
      }
    );
  });

  it("reads embedDimensions from GRAPHRAG_MEMORY_EMBED_DIMENSIONS as an integer", () => {
    withEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "2048" }, () => {
      expect(loadEnv().embedDimensions).toBe(2048);
    });
  });

  it("reads embedApiKey from the var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key-not-a-real-secret",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "test-model",
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("test-key-not-a-real-secret");
      }
    );
  });

  it("leaves embedApiKey undefined when no key source is declared", () => {
    withEnv({}, () => {
      expect(loadEnv().embedApiKey).toBeUndefined();
    });
  });

  it("accepts storage=pgvector when dbUrl is present", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_STORAGE: "pgvector",
        GRAPHRAG_MEMORY_DB_URL: "postgres://localhost:5432/graphrag",
      },
      () => {
        const env = loadEnv();
        expect(env.storage).toBe("pgvector");
        expect(env.dbUrl).toBe("postgres://localhost:5432/graphrag");
      }
    );
  });

  it("throws when storage=pgvector but dbUrl is missing", () => {
    withEnv({ GRAPHRAG_MEMORY_STORAGE: "pgvector" }, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_DB_URL/);
    });
  });

  it("throws on an unknown storage mode (no silent coercion)", () => {
    // Regression guard against the stage 0 dead-branch class of bug: an
    // unrecognized value must fail loudly, not fall back to "memory".
    withEnv({ GRAPHRAG_MEMORY_STORAGE: "sqlite" }, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_STORAGE/);
    });
  });
});

/**
 * Boundary tests for the embedding-config drift fix: every failure mode on
 * `GRAPHRAG_MEMORY_EMBED_DIMENSIONS` and the apiKey-coupled BASE_URL/MODEL
 * fields must throw ConfigError with a message naming the offending env var.
 *
 * Why these live in their own describe: they intentionally omit
 * GRAPHRAG_MEMORY_EMBED_DIMENSIONS so the default "1536" must NOT leak from
 * withEnv — the boundary is "dimensions missing" specifically. The targeted
 * patch in each test re-asserts the field so the only thing under test is
 * the input value.
 */
describe("loadEnv — embed config boundary cases", () => {
  // For these tests we want dimensions to be EXACTLY what the test sets
  // (including undefined), so we override withEnv with one that doesn't
  // inject a default.
  function withRawEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ) {
    withIsolatedEnv(
      DOTENV_MASK_KEYS,
      {
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
        GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: "60",
        GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "0.7",
        GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: "0.15",
        GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0.15",
        ...patch,
      },
      fn
    );
  }

  const DIM_BAD_VALUES: Array<readonly [string, string]> = [
    ["empty string", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["decimal", "3.14"],
    ["non-numeric", "abc"],
  ];

  for (const [label, value] of DIM_BAD_VALUES) {
    it(`throws on GRAPHRAG_MEMORY_EMBED_DIMENSIONS = "${value}" (${label})`, () => {
      withRawEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: value }, () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
      });
    });
  }

  it("throws when GRAPHRAG_MEMORY_EMBED_DIMENSIONS is unset", () => {
    withRawEnv({}, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
    });
  });

  it("throws when GRAPHRAG_MEMORY_EMBED_DIMENSIONS is whitespace-only", () => {
    withRawEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "   " }, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
    });
  });

  it("throws when a key is declared but BASE_URL is unset", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });

  it("throws when a key is declared but MODEL is unset", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "http://localhost:20128/v1",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_MODEL/);
      }
    );
  });

  // Blank-string normalization: an empty / whitespace-only value must behave
  // exactly like an unset var, so a blank key cannot drag an operator into
  // the real-embedder path and a blank BASE_URL/MODEL cannot slip past the
  // key-coupled required check to fail later at request time.
  it("throws when BASE_URL is an empty string but a key is declared", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });

  it("throws when BASE_URL is whitespace-only but a key is declared", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "   ",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });

  it("throws when MODEL is an empty string but a key is declared", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "http://localhost:20128/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_MODEL/);
      }
    );
  });

  it("treats an empty declared key var as unset (FakeEmbedder path, no baseUrl/model required)", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "",
      },
      () => {
        const env = loadEnv();
        expect(env.embedApiKey).toBeUndefined();
        expect(env.embedBaseUrl).toBeUndefined();
        expect(env.embedModel).toBeUndefined();
      }
    );
  });

  it("still requires dimensions even when NINE_ROUTER_KEY is unset", () => {
    withRawEnv({}, () => {
      // FakeEmbedder needs dimensions (which are NOT in the patch, so
      // withRawEnv leaves them absent — this should still throw because
      // dimensions is the always-required field). Combined with the next
      // test, this asserts that the FakeEmbedder path only enforces
      // dimensions, not baseUrl/model.
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
    });
  });

  it("FakeEmbedder path: dimensions alone is enough (no baseUrl, no model, no key)", () => {
    withRawEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "512" }, () => {
      const env = loadEnv();
      expect(env.embedDimensions).toBe(512);
      expect(env.embedApiKey).toBeUndefined();
      expect(env.embedBaseUrl).toBeUndefined();
      expect(env.embedModel).toBeUndefined();
    });
  });

  it("uses the pgvector ANN dimension ceiling default when it is absent", () => {
    const key = PGVECTOR_VARS[0];
    const saved = process.env[key];
    delete process.env[key];
    try {
      withIsolatedEnv(
        DOTENV_MASK_KEYS.filter((masked) => masked !== key),
        {
          GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
          GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: "60",
          GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "0.7",
          GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: "0.15",
          GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0.15",
        },
        () => {
          expect(loadEnv().pgvectorAnnMaxDimensions).toBe(2000);
        }
      );
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it("reads the pgvector ANN dimension ceiling from config", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "1024",
      },
      () => {
        expect(loadEnv().pgvectorAnnMaxDimensions).toBe(1024);
      }
    );
  });

  for (const [label, value] of [
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "not-a-number"],
    ["non-finite", "Infinity"],
  ] as const) {
    it(`rejects a ${label} pgvector ANN dimension ceiling`, () => {
      withRawEnv(
        {
          GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
          GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: value,
        },
        () => {
          expect(() => loadEnv()).toThrow(ConfigError);
          expect(() => loadEnv()).toThrow(
            /GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS/
          );
        }
      );
    });
  }
});

/**
 * API key resolution — host-agnostic indirection (removes the hardcoded
 * NINE_ROUTER_KEY).
 *
 * Resolution order: GRAPHRAG_MEMORY_EMBED_API_KEY (direct value) >
 * GRAPHRAG_MEMORY_VECTOR_API_KEY (preferred vector alias) >
 * GRAPHRAG_MEMORY_ANTHROPIC_API_KEY (legacy vector alias) >
 * process.env[GRAPHRAG_MEMORY_EMBED_API_KEY_ENV] (indirect by the var name
 * the operator declared) > undefined (FakeEmbedder). There is NO default
 * var name: if no source is set, the key is undefined even when NINE_ROUTER_KEY
 * happens to exist in the environment — the choice of key is declared in the
 * MCP layer, never decided by config. Every case scrubs all key-related vars
 * first so a developer machine's real key can't leak into the assertion.
 */
describe("loadEnv — embedding API key resolution", () => {
  const KEY_VARS = [
    "GRAPHRAG_MEMORY_EMBED_API_KEY",
    "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
    "GRAPHRAG_MEMORY_VECTOR_API_KEY",
    "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "NINE_ROUTER_KEY",
    "CUSTOM_KEY_VAR",
  ] as const;

  function withKeyEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ) {
    withIsolatedEnv(
      [...DOTENV_MASK_KEYS, ...KEY_VARS],
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
        GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: "60",
        GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "0.7",
        GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: "0.15",
        GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0.15",
        ...patch,
      },
      fn
    );
  }

  // When a key resolves, loadEnv enforces BASE_URL + MODEL, so every
  // resolution test below supplies them — the only thing under test is
  // which source the key value came from.
  const ENDPOINT = {
    GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
    GRAPHRAG_MEMORY_EMBED_MODEL: "test-model",
  };

  it("reads a direct value from GRAPHRAG_MEMORY_EMBED_API_KEY", () => {
    withKeyEnv(
      { GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret", ...ENDPOINT },
      () => {
        expect(loadEnv().embedApiKey).toBe("direct-secret");
      }
    );
  });

  it("reads the vector key GRAPHRAG_MEMORY_ANTHROPIC_API_KEY when EMBED_API_KEY is unset", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_ANTHROPIC_API_KEY: "vector-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("vector-secret");
      }
    );
  });

  it("reads the preferred vector key GRAPHRAG_MEMORY_VECTOR_API_KEY when EMBED_API_KEY is unset", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_VECTOR_API_KEY: "preferred-vector-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("preferred-vector-secret");
      }
    );
  });

  it("EMBED_API_KEY wins over GRAPHRAG_MEMORY_ANTHROPIC_API_KEY", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret",
        GRAPHRAG_MEMORY_VECTOR_API_KEY: "preferred-vector-secret",
        GRAPHRAG_MEMORY_ANTHROPIC_API_KEY: "vector-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("direct-secret");
      }
    );
  });

  it("preferred vector key wins over the legacy vector alias", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_VECTOR_API_KEY: "preferred-vector-secret",
        GRAPHRAG_MEMORY_ANTHROPIC_API_KEY: "legacy-vector-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("preferred-vector-secret");
      }
    );
  });

  it("does not treat ANTHROPIC_AUTH_TOKEN as an embedding key", () => {
    withKeyEnv(
      {
        ANTHROPIC_AUTH_TOKEN: "llm-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBeUndefined();
      }
    );
  });

  it("direct value wins over the var-name path", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "env-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("direct-secret");
      }
    );
  });

  it("reads NINE_ROUTER_KEY only when the operator declares it via _API_KEY_ENV (no implicit default)", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "env-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("env-secret");
      }
    );
  });

  it("ignores NINE_ROUTER_KEY when no key source is declared (no default)", () => {
    withKeyEnv({ NINE_ROUTER_KEY: "env-secret" }, () => {
      expect(loadEnv().embedApiKey).toBeUndefined();
    });
  });

  it("reads from a custom var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "CUSTOM_KEY_VAR",
        CUSTOM_KEY_VAR: "custom-secret",
        NINE_ROUTER_KEY: "should-be-ignored",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("custom-secret");
      }
    );
  });

  it("treats a blank direct value as unset and falls back to the declared var-name", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "   ",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "env-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("env-secret");
      }
    );
  });

  it("treats a blank var-name as unset (no default, so key is undefined)", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "  ",
        NINE_ROUTER_KEY: "env-secret",
      },
      () => {
        expect(loadEnv().embedApiKey).toBeUndefined();
      }
    );
  });

  it("leaves embedApiKey undefined when neither source resolves", () => {
    withKeyEnv({}, () => {
      expect(loadEnv().embedApiKey).toBeUndefined();
    });
  });

  it("requires BASE_URL when a direct-value key is set", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });
});

/**
 * Hybrid retrieval knobs (#59 / #64 / #70).
 *
 * Production retrieve fuses vector + BM25 + the Neo4j graph arm at
 * 0.7 / 0.15 / 0.15, with both partner arms on by default (#69/#70 —
 * `w_graph` steers production again). Every invalid value must abort at
 * startup with a `ConfigError` naming the offending var rather than
 * silently falling back to a default — an operator who typo'd a weight
 * would otherwise run a ranking they never asked for and have no way to
 * notice.
 */
describe("loadEnv — hybrid retrieval weights + arm switches", () => {
  function withRetrievalEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ) {
    const keys = [
      ...RETRIEVAL_VARS,
      ...PGVECTOR_VARS,
      ...ANTHROPIC_VARS,
      "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
      "GRAPHRAG_MEMORY_EMBED_BASE_URL",
      "GRAPHRAG_MEMORY_EMBED_MODEL",
      "GRAPHRAG_MEMORY_EMBED_API_KEY",
    ];
    const saved = new Map<string, string | undefined>();
    for (const k of keys) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
    process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_RRF_K"] = "60";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_VEC"] = "0.7";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_BM25"] = "0.15";
    process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH"] = "0.15";
    for (const [k, v] of Object.entries(patch)) {
      if (!saved.has(k)) saved.set(k, process.env[k]);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  // SC6 — the three-arm defaults #69 locked. A fresh env must produce
  // exactly these numbers; anything else means an operator's ranking
  // silently drifted from the spec.
  it("defaults a fresh env to the three-arm hybrid: w_vec 0.7, w_bm25 0.15, w_graph 0.15", () => {
    withRetrievalEnv({}, () => {
      const { retrieval } = loadEnv();
      expect(retrieval.w_vec).toBe(0.7);
      expect(retrieval.w_bm25).toBe(0.15);
      expect(retrieval.w_graph).toBe(0.15);
    });
  });

  it("defaults RRF k to 60 on a fresh configuration", () => {
    withRetrievalEnv({}, () => {
      expect(loadEnv().retrieval.rrfK).toBe(60);
    });
  });

  it("reads RRF k from configuration", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: "1000" }, () => {
      expect(loadEnv().retrieval.rrfK).toBe(1000);
    });
  });

  for (const [label, value] of [
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "not-a-number"],
    ["non-finite NaN", "NaN"],
    ["non-finite Infinity", "Infinity"],
  ] as const) {
    it(`rejects ${label} RRF k with ConfigError`, () => {
      withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: value }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_RRF_K/);
      });
    });
  }

  it("defaults the retrieve mode bundle to balanced with its locked levers", () => {
    withRetrievalEnv({}, () => {
      const { retrieval } = loadEnv();
      expect(retrieval.preset).toBe("balanced");
      expect(retrieval.entityLinkTopK).toBe(8);
      expect(retrieval.candidateCap).toBe(50);
      expect(retrieval.w_vec).toBe(0.7);
      expect(retrieval.w_bm25).toBe(0.15);
      expect(retrieval.neighborWidth).toBe(1);
    });
  });

  it("applies the conservative bundle with a narrower window and no neighbors", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_PRESET: "conservative" },
      () => {
        const { retrieval } = loadEnv();
        expect(retrieval.preset).toBe("conservative");
        expect(retrieval.entityLinkTopK).toBeLessThan(8);
        expect(retrieval.candidateCap).toBeLessThan(50);
        expect(retrieval.neighborWidth).toBe(0);
        expect(retrieval.w_vec).toBe(0.7);
        expect(retrieval.w_bm25).toBe(0.15);
      }
    );
  });

  it("applies the tokenmax bundle with a wider window and neighbor evidence", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_PRESET: "tokenmax" }, () => {
      const { retrieval } = loadEnv();
      expect(retrieval.preset).toBe("tokenmax");
      expect(retrieval.entityLinkTopK).toBeGreaterThan(8);
      expect(retrieval.candidateCap).toBeGreaterThan(50);
      expect(retrieval.neighborWidth).toBeGreaterThanOrEqual(1);
      expect(retrieval.w_vec).toBe(0.7);
      expect(retrieval.w_bm25).toBe(0.15);
    });
  });

  it("rejects an unknown retrieve mode bundle with ConfigError", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_PRESET: "fast" }, () => {
      expect(() => loadEnv()).toThrow(ConfigError);
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_PRESET/);
    });
  });

  it("SC6: both partner arms are enabled on a fresh env", () => {
    withRetrievalEnv({}, () => {
      const { retrieval } = loadEnv();
      expect(retrieval.bm25Enabled).toBe(true);
      expect(retrieval.graphEnabled).toBe(true);
    });
  });

  it("keeps direct node-embedding retrieval off by default", () => {
    withRetrievalEnv({}, () => {
      expect(loadEnv().retrieval.nodeEmbeddingEnabled).toBe(false);
    });
  });

  it("enables direct node-embedding retrieval explicitly", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_NODE_EMBEDDING_ENABLED: "true" },
      () => {
        expect(loadEnv().retrieval.nodeEmbeddingEnabled).toBe(true);
      }
    );
  });

  it("defaults rerank enable to false on a fresh env", () => {
    withRetrievalEnv({}, () => {
      expect(loadEnv().retrieval.rerankEnabled).toBe(false);
    });
  });

  it("defaults wait-for-drain to disabled with a bounded timeout", () => {
    withRetrievalEnv({}, () => {
      const { retrieval } = loadEnv();
      expect(retrieval.waitForDrainEnabled).toBe(false);
      expect(retrieval.waitForDrainTimeoutMs).toBe(5000);
    });
  });

  it("reads wait-for-drain enablement and timeout from env", () => {
    withRetrievalEnv(
      {
        GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_ENABLED: "true",
        GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS: "250",
      },
      () => {
        const { retrieval } = loadEnv();
        expect(retrieval.waitForDrainEnabled).toBe(true);
        expect(retrieval.waitForDrainTimeoutMs).toBe(250);
      }
    );
  });

  it("rejects a non-positive wait-for-drain timeout", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS: "0" },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(
          /GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS/
        );
      }
    );
  });

  it("leaves the dedicated rerank URL undefined by default", () => {
    withRetrievalEnv({}, () => {
      expect(loadEnv().rerankUrl).toBeUndefined();
    });
  });

  it("reads and trims the dedicated rerank URL without requiring Anthropic credentials", () => {
    withRetrievalEnv(
      {
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL:
          "  https://rerank.example.test/v1/  ",
      },
      () => {
        expect(loadEnv().rerankUrl).toBe("https://rerank.example.test/v1/");
        expect(loadEnv().rerank).toBeUndefined();
      }
    );
  });

  it("treats a blank dedicated rerank URL as absent", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL: "   " }, () => {
      expect(loadEnv().rerankUrl).toBeUndefined();
    });
  });

  it("turns rerank on when the enable flag is true", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "true" },
      () => {
        expect(loadEnv().retrieval.rerankEnabled).toBe(true);
      }
    );
  });

  it("accepts 1 / 0 / case-insensitive rerank enable flags", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "1" }, () => {
      expect(loadEnv().retrieval.rerankEnabled).toBe(true);
    });
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "FALSE" },
      () => {
        expect(loadEnv().retrieval.rerankEnabled).toBe(false);
      }
    );
  });

  it("treats a blank rerank enable flag as the default off", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "   " },
      () => {
        expect(loadEnv().retrieval.rerankEnabled).toBe(false);
      }
    );
  });

  for (const value of ["yes", "on", "2"]) {
    it(`rejects rerank enable = "${value}" with ConfigError`, () => {
      withRetrievalEnv(
        { GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: value },
        () => {
          expect(() => loadEnv()).toThrow(ConfigError);
          expect(() => loadEnv()).toThrow(
            /GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED/
          );
        }
      );
    });
  }

  it("skips the rerank credential block when the Anthropic trio is absent", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "true" },
      () => {
        const env = loadEnv();
        expect(env.retrieval.rerankEnabled).toBe(true);
        expect(env.rerank).toBeUndefined();
      }
    );
  });

  it("does not treat GRAPHRAG_MEMORY_VECTOR_API_KEY as the rerank LLM secret", () => {
    withRetrievalEnv(
      {
        GRAPHRAG_MEMORY_VECTOR_API_KEY: "preferred-vector-secret",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://embed.example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-test",
      },
      () => {
        const env = loadEnv();
        expect(env.rerank).toBeUndefined();
        expect(env.embedApiKey).toBe("preferred-vector-secret");
      }
    );
  });

  it("defaults MiniMax-M3 China Anthropic URL when only ANTHROPIC_AUTH_TOKEN is set", () => {
    withRetrievalEnv(
      {
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "true",
        ANTHROPIC_AUTH_TOKEN: "test-key-not-a-real-secret",
      },
      () => {
        expect(() => loadEnv()).not.toThrow();
        expect(loadEnv().rerank).toEqual({
          apiKey: "test-key-not-a-real-secret",
          model: "MiniMax-M3",
          baseUrl: "https://api.minimaxi.com/anthropic",
        });
      }
    );
  });

  it("does not treat GRAPHRAG_MEMORY_ANTHROPIC_API_KEY as the rerank LLM secret", () => {
    withRetrievalEnv(
      {
        GRAPHRAG_MEMORY_ANTHROPIC_API_KEY: "test-key-not-a-real-secret",
        GRAPHRAG_MEMORY_ANTHROPIC_MODEL: "claude-test",
        GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL: "https://example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://embed.example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-test",
      },
      () => {
        const env = loadEnv();
        expect(env.rerank).toBeUndefined();
        expect(env.embedApiKey).toBe("test-key-not-a-real-secret");
      }
    );
  });

  it("loads the rerank block when ANTHROPIC_AUTH_TOKEN and model/base URL are present", () => {
    withRetrievalEnv(
      {
        ANTHROPIC_AUTH_TOKEN: "test-key-not-a-real-secret",
        GRAPHRAG_MEMORY_ANTHROPIC_MODEL: "claude-test",
        GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL: "https://example.invalid/v1",
      },
      () => {
        expect(loadEnv().rerank).toEqual({
          apiKey: "test-key-not-a-real-secret",
          model: "claude-test",
          baseUrl: "https://example.invalid/v1",
        });
      }
    );
  });

  it("leaves the seed / traversal knobs at their prior defaults", () => {
    withRetrievalEnv({}, () => {
      const { retrieval } = loadEnv();
      expect(retrieval.entityLinkTopK).toBe(8);
      expect(retrieval.candidateCap).toBe(50);
      expect(retrieval.graphArmFloor).toBe(3);
    });
  });

  it("reads an operator override for w_bm25", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: "0.5" }, () => {
      expect(loadEnv().retrieval.w_bm25).toBe(0.5);
    });
  });

  it("reads an operator override for w_vec", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "1.25" }, () => {
      expect(loadEnv().retrieval.w_vec).toBe(1.25);
    });
  });

  const BAD_WEIGHTS: Array<readonly [string, string]> = [
    ["negative", "-0.2"],
    ["zero", "0"],
    ["non-numeric", "heavy"],
    ["NaN", "NaN"],
    ["infinite", "Infinity"],
  ];

  for (const [label, value] of BAD_WEIGHTS) {
    it(`rejects w_bm25 = "${value}" (${label}) with ConfigError`, () => {
      withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: value }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_W_BM25/);
      });
    });
  }

  for (const [label, value] of BAD_WEIGHTS) {
    it(`rejects w_vec = "${value}" (${label}) with ConfigError`, () => {
      withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: value }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_W_VEC/);
      });
    });
  }

  it("turns BM25 off when the enable flag is false", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false" },
      () => {
        expect(loadEnv().retrieval.bm25Enabled).toBe(false);
      }
    );
  });

  it("accepts 1 / 0 and mixed case for the enable flag", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "0" }, () => {
      expect(loadEnv().retrieval.bm25Enabled).toBe(false);
    });
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "1" }, () => {
      expect(loadEnv().retrieval.bm25Enabled).toBe(true);
    });
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "FALSE" },
      () => {
        expect(loadEnv().retrieval.bm25Enabled).toBe(false);
      }
    );
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: " true " },
      () => {
        expect(loadEnv().retrieval.bm25Enabled).toBe(true);
      }
    );
  });

  it("treats a blank enable flag as unset and keeps BM25 on", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "   " }, () => {
      expect(loadEnv().retrieval.bm25Enabled).toBe(true);
    });
  });

  const BAD_FLAGS = ["maybe", "2", "on", "yes", "-1"];

  for (const value of BAD_FLAGS) {
    it(`rejects an unparseable enable flag "${value}" instead of guessing`, () => {
      withRetrievalEnv(
        { GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: value },
        () => {
          expect(() => loadEnv()).toThrow(ConfigError);
          expect(() => loadEnv()).toThrow(
            /GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED/
          );
        }
      );
    });
  }

  it("reads an operator override for w_graph", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0.4" }, () => {
      expect(loadEnv().retrieval.w_graph).toBe(0.4);
    });
  });

  for (const [label, value] of BAD_WEIGHTS) {
    it(`rejects w_graph = "${value}" (${label}) with ConfigError`, () => {
      withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: value }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH/);
      });
    });
  }

  // SC9 at the config layer: switching the graph arm off is a choice, not
  // a degradation. Config must record the choice and leave every other
  // arm exactly as it was — nothing here may hint at a failed attempt.
  it("SC9: turning the graph arm off leaves the remaining arms untouched", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false" },
      () => {
        const { retrieval } = loadEnv();
        expect(retrieval.graphEnabled).toBe(false);
        expect(retrieval.bm25Enabled).toBe(true);
        expect(retrieval.w_vec).toBe(0.7);
        expect(retrieval.w_bm25).toBe(0.15);
      }
    );
  });

  it("SC9: the graph arm can be disabled without any Neo4j config present", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "0" }, () => {
      expect(() => loadEnv()).not.toThrow();
      expect(loadEnv().retrieval.graphEnabled).toBe(false);
    });
  });

  it("accepts 1 / mixed case / padding for the graph enable flag", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "1" }, () => {
      expect(loadEnv().retrieval.graphEnabled).toBe(true);
    });
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "FALSE" },
      () => {
        expect(loadEnv().retrieval.graphEnabled).toBe(false);
      }
    );
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: " true " },
      () => {
        expect(loadEnv().retrieval.graphEnabled).toBe(true);
      }
    );
  });

  it("treats a blank graph enable flag as unset and keeps the arm on", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "   " }, () => {
      expect(loadEnv().retrieval.graphEnabled).toBe(true);
    });
  });

  for (const value of BAD_FLAGS) {
    it(`rejects an unparseable graph enable flag "${value}" instead of guessing`, () => {
      withRetrievalEnv(
        { GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: value },
        () => {
          expect(() => loadEnv()).toThrow(ConfigError);
          expect(() => loadEnv()).toThrow(
            /GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED/
          );
        }
      );
    });
  }
});

/**
 * Neo4j sidecar connection block (#70 T1).
 *
 * The block is `undefined` when no URI is configured, which is the config
 * half of SC7: the graph arm cannot even be attempted, so retrieve skips
 * it and the envelope stays non-degraded. Everything an operator DID
 * declare must either be usable or refuse to start — a URI with an
 * unusable scheme, or half a credential pair, is a typo the server must
 * not paper over by connecting anonymously or by ignoring the value.
 */
describe("loadEnv — Neo4j sidecar config", () => {
  function withNeo4jEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ) {
    const keys = [...NEO4J_VARS, "GRAPHRAG_MEMORY_EMBED_DIMENSIONS"];
    const saved = new Map<string, string | undefined>();
    for (const k of keys) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
    for (const [k, v] of Object.entries(patch)) {
      if (!saved.has(k)) saved.set(k, process.env[k]);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("leaves the block undefined on a fresh env (nothing to attempt)", () => {
    withNeo4jEnv({}, () => {
      expect(loadEnv().neo4j).toBeUndefined();
    });
  });

  it("treats a blank URI as unset", () => {
    withNeo4jEnv({ GRAPHRAG_MEMORY_NEO4J_URI: "   " }, () => {
      expect(loadEnv().neo4j).toBeUndefined();
    });
  });

  it("reads an unauthenticated URI with no credentials", () => {
    withNeo4jEnv({ GRAPHRAG_MEMORY_NEO4J_URI: "bolt://localhost:7687" }, () => {
      expect(loadEnv().neo4j).toEqual({
        uri: "bolt://localhost:7687",
        user: undefined,
        password: undefined,
      });
    });
  });

  it("reads the full URI + user + password triple", () => {
    withNeo4jEnv(
      {
        GRAPHRAG_MEMORY_NEO4J_URI: "neo4j://graph.invalid:7687",
        GRAPHRAG_MEMORY_NEO4J_USER: "neo4j",
        GRAPHRAG_MEMORY_NEO4J_PASSWORD: "  not-a-real-secret  ",
      },
      () => {
        expect(loadEnv().neo4j).toEqual({
          uri: "neo4j://graph.invalid:7687",
          user: "neo4j",
          // Trimmed like every other string field, so a stray newline in a
          // shell export cannot become part of the credential.
          password: "not-a-real-secret",
        });
      }
    );
  });

  it("trims padding off the URI rather than handing it to the driver", () => {
    withNeo4jEnv(
      { GRAPHRAG_MEMORY_NEO4J_URI: "  neo4j://localhost:7687  " },
      () => {
        expect(loadEnv().neo4j?.uri).toBe("neo4j://localhost:7687");
      }
    );
  });

  const GOOD_SCHEMES = [
    "bolt://localhost:7687",
    "bolt+s://graph.invalid:7687",
    "bolt+ssc://graph.invalid:7687",
    "neo4j://localhost:7687",
    "neo4j+s://graph.invalid:7687",
    "neo4j+ssc://graph.invalid:7687",
  ];

  for (const uri of GOOD_SCHEMES) {
    it(`accepts the driver scheme in "${uri}"`, () => {
      withNeo4jEnv({ GRAPHRAG_MEMORY_NEO4J_URI: uri }, () => {
        expect(loadEnv().neo4j?.uri).toBe(uri);
      });
    });
  }

  const BAD_URIS: Array<readonly [string, string]> = [
    ["http scheme", "http://localhost:7687"],
    ["postgres scheme", "postgres://localhost:5432/graphrag"],
    ["no scheme", "localhost:7687"],
    ["not a URI at all", "definitely not a uri"],
  ];

  for (const [label, uri] of BAD_URIS) {
    it(`rejects "${uri}" (${label}) with ConfigError`, () => {
      withNeo4jEnv({ GRAPHRAG_MEMORY_NEO4J_URI: uri }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_NEO4J_URI/);
      });
    });
  }

  it("rejects a user with no password", () => {
    withNeo4jEnv(
      {
        GRAPHRAG_MEMORY_NEO4J_URI: "bolt://localhost:7687",
        GRAPHRAG_MEMORY_NEO4J_USER: "neo4j",
      },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_NEO4J_PASSWORD/);
      }
    );
  });

  it("rejects a password with no user, naming the var and not the secret", () => {
    withNeo4jEnv(
      {
        GRAPHRAG_MEMORY_NEO4J_URI: "bolt://localhost:7687",
        GRAPHRAG_MEMORY_NEO4J_PASSWORD: "hunter2",
      },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_NEO4J_USER/);
        expect(() => loadEnv()).not.toThrow(/hunter2/);
      }
    );
  });

  it("rejects credentials declared without a URI (nothing to connect to)", () => {
    withNeo4jEnv(
      {
        GRAPHRAG_MEMORY_NEO4J_USER: "neo4j",
        GRAPHRAG_MEMORY_NEO4J_PASSWORD: "not-a-real-secret",
      },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_NEO4J_URI/);
      }
    );
  });

  it("never puts the password in the ConfigError message", () => {
    withNeo4jEnv(
      {
        GRAPHRAG_MEMORY_NEO4J_URI: "http://localhost:7687",
        GRAPHRAG_MEMORY_NEO4J_USER: "neo4j",
        GRAPHRAG_MEMORY_NEO4J_PASSWORD: "super-secret-value",
      },
      () => {
        const err = (() => {
          try {
            loadEnv();
            return undefined;
          } catch (e) {
            return e as Error;
          }
        })();
        expect(err).toBeInstanceOf(ConfigError);
        expect(err?.message).not.toContain("super-secret-value");
      }
    );
  });
});
