/**
 * Embedding generation rotate T2 — dual-write slot helper unit tests.
 *
 * `embedSlotVectors` is the SSOT: one helper computes the per-slot vector
 * batches for a text set, used by the chunk, entity and community-summary
 * write paths. The env-configured embedder covers whichever pair matches
 * env (the boot guard guarantees one of them does); the OTHER slot's pair
 * goes through the embedder factory.
 */
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../../src/config.js";
import { GraphragError } from "../../src/core/errors.js";
import {
  createSlotEmbeddingSource,
  dualWriteOpen,
  embedSlotVectors,
  embedWithSlotFallback,
  readSlotGenerationState,
  slotWriteTargets,
  type SlotEmbeddingSource,
} from "../../src/core/embed-slots.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type { Logger } from "../../src/logging.js";
import type {
  EmbeddingGenerationPair,
  EmbeddingGenerationState,
} from "../../src/core/types.js";

function makeState(
  overrides: Partial<EmbeddingGenerationState> = {}
): EmbeddingGenerationState {
  return {
    activeSlot: "embedding",
    active: { model: "m1", dimensions: 8 },
    incomingSlot: "embedding_g2",
    incoming: { model: "m2", dimensions: 8 },
    rotateMode: "dual_write",
    rollbackSlot: null,
    rollback: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Tagged fake embedder: distinct model tags give distinct vectors. */
function taggingEmbedder(
  tag: string,
  calls: string[]
): EmbeddingClient & { embed: (texts: string[]) => Promise<number[][]> } {
  return {
    modelId: tag,
    embed: async (texts: string[]) => {
      calls.push(tag);
      return texts.map((text, i) => [
        ...Array.from(tag).map((c) => c.charCodeAt(0)),
        text.length,
        i,
      ]);
    },
  };
}

function makeSource(desired: EmbeddingGenerationPair) {
  const calls: string[] = [];
  const buildEmbedder = vi.fn((pair: EmbeddingGenerationPair) =>
    taggingEmbedder(`built:${pair.model}/${pair.dimensions}`, calls)
  );
  const source: SlotEmbeddingSource = {
    embedder: taggingEmbedder("env", calls),
    desired,
    buildEmbedder,
  };
  return { source, calls, buildEmbedder };
}

function recordingLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const logger = {
    level: "info",
    debug: (msg: string) => events.push(`debug:${msg}`),
    info: (msg: string) => events.push(`info:${msg}`),
    warn: (msg: string) => events.push(`warn:${msg}`),
    error: (msg: string) => events.push(`error:${msg}`),
  } satisfies Logger;
  return { logger, events };
}

describe("dualWriteOpen", () => {
  it("is true only for an open rotate in dual_write mode", () => {
    expect(dualWriteOpen(null)).toBe(false);
    expect(dualWriteOpen(undefined)).toBe(false);
    expect(dualWriteOpen(makeState({ incomingSlot: null, incoming: null }))).toBe(
      false
    );
    expect(dualWriteOpen(makeState({ rotateMode: "downtime" }))).toBe(false);
    expect(dualWriteOpen(makeState())).toBe(true);
  });
});

describe("embedSlotVectors", () => {
  it("without a ledger row behaves exactly like the legacy single embed", async () => {
    const { source, calls, buildEmbedder } = makeSource({
      model: "m1",
      dimensions: 8,
    });
    const { logger, events } = recordingLogger();

    const batches = await embedSlotVectors(source, null, ["a", "b"], {
      logger,
      eventName: "embed",
      itemCount: 2,
    });

    expect(batches.incoming).toBeNull();
    expect(batches.active).toHaveLength(2);
    expect(calls).toEqual(["env"]);
    expect(buildEmbedder).not.toHaveBeenCalled();
    // SC10: one log entry per embed call — legacy path stays at one entry.
    expect(events).toEqual(["info:embed"]);
  });

  it("open rotate with desired == active embeds the incoming slot through the factory with the incoming pair", async () => {
    const { source, calls, buildEmbedder } = makeSource({
      model: "m1",
      dimensions: 8,
    });
    const state = makeState();

    const batches = await embedSlotVectors(source, state, ["a", "b"]);

    expect(buildEmbedder).toHaveBeenCalledTimes(1);
    expect(buildEmbedder).toHaveBeenCalledWith({ model: "m2", dimensions: 8 });
    expect(calls).toEqual(["env", "built:m2/8"]);
    expect(batches.active).toHaveLength(2);
    expect(batches.incoming).toHaveLength(2);
    // The two slots must land in different vector spaces (tag differs).
    expect(batches.incoming![0]).not.toEqual(batches.active[0]);
  });

  it("open rotate with desired == incoming embeds the active slot through the factory with the active pair", async () => {
    const { source, calls, buildEmbedder } = makeSource({
      model: "m2",
      dimensions: 8,
    });
    const state = makeState();

    const batches = await embedSlotVectors(source, state, ["a"]);

    expect(buildEmbedder).toHaveBeenCalledTimes(1);
    expect(buildEmbedder).toHaveBeenCalledWith({ model: "m1", dimensions: 8 });
    expect(calls).toEqual(["built:m1/8", "env"]);
    expect(batches.active).toHaveLength(1);
    expect(batches.incoming).toHaveLength(1);
    expect(batches.incoming![0]).not.toEqual(batches.active[0]);
  });

  it("secondary embed failure propagates the typed error before anything is returned", async () => {
    const calls: string[] = [];
    const source: SlotEmbeddingSource = {
      embedder: taggingEmbedder("env", calls),
      desired: { model: "m1", dimensions: 8 },
      buildEmbedder: () => {
        throw new GraphragError("secondary embedder down", "EMBEDDING_FAILED");
      },
    };

    const err = await embedSlotVectors(
      source,
      makeState(),
      ["a"]
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
  });

  it("includeIncoming=false never touches the incoming slot (backfill path)", async () => {
    const { source, calls, buildEmbedder } = makeSource({
      model: "m1",
      dimensions: 8,
    });

    const batches = await embedSlotVectors(source, makeState(), ["a"], {
      includeIncoming: false,
    });

    expect(batches.incoming).toBeNull();
    expect(calls).toEqual(["env"]);
    expect(buildEmbedder).not.toHaveBeenCalled();
  });

  it("downtime-mode rotate does not dual-embed", async () => {
    const { source, buildEmbedder } = makeSource({
      model: "m1",
      dimensions: 8,
    });

    const batches = await embedSlotVectors(
      source,
      makeState({ rotateMode: "downtime" }),
      ["a"]
    );

    expect(batches.incoming).toBeNull();
    expect(buildEmbedder).not.toHaveBeenCalled();
  });
});

describe("embedWithSlotFallback", () => {
  it("legacy unwired call sites keep today's single-embedder behavior", async () => {
    const calls: string[] = [];
    const embedder = taggingEmbedder("env", calls);
    const { logger, events } = recordingLogger();

    const batches = await embedWithSlotFallback({
      embedder,
      state: null,
      site: "unit",
      texts: ["a", "b"],
      logger,
      eventName: "embed",
      itemCount: 2,
    });

    expect(batches.incoming).toBeNull();
    expect(batches.active).toHaveLength(2);
    expect(calls).toEqual(["env"]);
    expect(events).toEqual(["info:embed"]);
  });

  it("refuses (typed) when a dual-write rotate is open but slotEmbedding is not wired", async () => {
    const calls: string[] = [];
    const err = await embedWithSlotFallback({
      embedder: taggingEmbedder("env", calls),
      state: makeState(),
      site: "ingest",
      texts: ["a"],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect((err as Error).message).toContain("ingest");
    // The refusal happens BEFORE any embed call — nothing half-written.
    expect(calls).toEqual([]);
  });

  it("routes to the slot helper when slotEmbedding is present", async () => {
    const { source, buildEmbedder } = makeSource({
      model: "m1",
      dimensions: 8,
    });

    const batches = await embedWithSlotFallback({
      embedder: source.embedder,
      slotEmbedding: source,
      state: makeState(),
      site: "ingest",
      texts: ["a"],
    });

    expect(batches.incoming).toHaveLength(1);
    expect(buildEmbedder).toHaveBeenCalledWith({ model: "m2", dimensions: 8 });
  });
});

describe("readSlotGenerationState", () => {
  const ledgerRow = {
    active_slot: "embedding",
    active_model: "m1",
    active_dimensions: 8,
    incoming_slot: "embedding_g2",
    incoming_model: "m2",
    incoming_dimensions: 8,
    rotate_mode: "dual_write",
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("adapts a required-values queryable (extraction Queryable) to the ledger read", async () => {
    const seen: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: async (sql: string, values: unknown[]) => {
        seen.push({ sql, values });
        return { rows: [ledgerRow] };
      },
    };

    const state = await readSlotGenerationState(client);

    expect(state).not.toBeNull();
    expect(state!.activeSlot).toBe("embedding");
    expect(state!.incomingSlot).toBe("embedding_g2");
    expect(state!.rotateMode).toBe("dual_write");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain("embedding_generation");
  });

  it("returns null when no singleton row exists", async () => {
    const client = { query: async () => ({ rows: [] }) };
    expect(await readSlotGenerationState(client)).toBeNull();
  });
});

describe("slotWriteTargets", () => {
  it("without a ledger row keeps the legacy column and no incoming", () => {
    expect(slotWriteTargets(null)).toEqual({
      activeSlot: "embedding",
      incomingSlot: null,
    });
  });

  it("dual-write open exposes both slot identifiers", () => {
    expect(slotWriteTargets(makeState())).toEqual({
      activeSlot: "embedding",
      incomingSlot: "embedding_g2",
    });
  });

  it("downtime mode does not dual-write", () => {
    expect(slotWriteTargets(makeState({ rotateMode: "downtime" }))).toEqual({
      activeSlot: "embedding",
      incomingSlot: null,
    });
  });
});

describe("createSlotEmbeddingSource", () => {
  it("buildEmbedder reuses the env credentials with the requested pair", () => {
    const env = {
      apiKey: "test-key-not-secret",
      baseUrl: "https://embed.invalid/v1",
      model: "m1",
      dimensions: 8,
    };
    const calls: string[] = [];
    const source = createSlotEmbeddingSource(
      env,
      taggingEmbedder("env", calls)
    );

    expect(source.desired).toEqual({ model: "m1", dimensions: 8 });
    const secondary = source.buildEmbedder({ model: "m2", dimensions: 16 });
    // Factory-shape proof: the returned client carries the PAIR, not env.
    expect(secondary.modelId).toBe("m2");
  });

  it("keyless env cannot build a persisting secondary embedder", () => {
    const calls: string[] = [];
    const source = createSlotEmbeddingSource(
      { apiKey: undefined, baseUrl: undefined, model: undefined, dimensions: 8 },
      taggingEmbedder("env", calls)
    );

    expect(() =>
      source.buildEmbedder({ model: "m2", dimensions: 8 })
    ).toThrow(ConfigError);
  });
});
