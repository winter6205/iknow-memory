import { describe, it, expect } from "vitest";
import {
  CandidateSetNotWiredError,
  mergeEntitiesWithGating,
  normalizeAlias,
  type CandidateEntity,
  type Embedder,
  type GrayZoneLog,
} from "../../src/core/entities/merge.js";
import {
  DEFAULT_MERGE_CONFIG,
  type GrayZoneJudge,
  type GrayZoneJudgeInput,
  type GrayZoneVerdict,
} from "../../src/core/entities/types.js";
import { cosineSimilarity } from "../../src/core/cosine.js";
import { GraphragError } from "../../src/core/errors.js";

/**
 * Deterministic test embedder: hashes each input to a fixed-length vector.
 * Tests use the `overrides` map to pin the exact cosine values for the
 * specific strings the merge gate reads, while any incidental string falls
 * back to the hash. Same text → same vector; cosine via `src/core/cosine.ts`.
 */
const DIM = 8;

function basisVector(index: number): number[] {
  const out = new Array<number>(DIM).fill(0);
  out[index % DIM] = 1;
  return out;
}

function hashVec(text: string): number[] {
  const out = new Array<number>(DIM);
  let acc = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    acc ^= text.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }
  let state = (acc ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < DIM; i += 1) {
    state = Math.imul(state ^ (i + 1), 0x85ebca6b) >>> 0;
    state ^= state >>> 13;
    state = Math.imul(state, 0xc2b2ae35) >>> 0;
    state ^= state >>> 16;
    out[i] = (state / 0xffffffff) * 2 - 1;
  }
  return out;
}

function makeFakeEmbedder(overrides: Record<string, number[]> = {}): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => overrides[t] ?? hashVec(t));
    },
  };
}

/**
 * Counting variant of the fake embedder: records every `embed` call and the
 * texts it received, so a test can prove which side of an L3 comparison was
 * embedded. The shared `FakeEmbedder` carries no counter, hence the local one.
 */
function makeCountingEmbedder(overrides: Record<string, number[]> = {}) {
  const calls: string[][] = [];
  const embedder: Embedder = {
    async embed(texts: string[]): Promise<number[][]> {
      calls.push([...texts]);
      return texts.map((t) => overrides[t] ?? hashVec(t));
    },
  };
  const embeddedTexts = (): string[] => calls.flat();
  const countOf = (text: string): number =>
    embeddedTexts().filter((t) => t === text).length;
  return { embedder, calls, embeddedTexts, countOf };
}

function candidate(over: Partial<CandidateEntity>): CandidateEntity {
  return {
    id: "cand-1",
    canonicalName: "Alice",
    type: "person",
    description: "a software engineer at Acme corp",
    ...over,
  };
}

function graySpy() {
  const entries: GrayZoneLog[] = [];
  return { entries, fn: (e: GrayZoneLog) => entries.push(e) };
}

describe("normalizeAlias", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeAlias("  Alice   Smith  ")).toBe("alice smith");
  });
});

describe("mergeEntitiesWithGating — L0", () => {
  it("merges two entities with the same normalized name and same type", async () => {
    const embedder = makeFakeEmbedder();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "alice smith", type: "person", description: "engineer" },
      [
        candidate({
          id: "cand-1",
          canonicalName: "Alice Smith",
          type: "person",
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision).toEqual({
      kind: "merge",
      into: "cand-1",
      via: "L0",
      observedCosine: 1.0,
    });
    expect(out.canonicalId).toBe("cand-1");
  });
});

describe("mergeEntitiesWithGating — L1 type reject", () => {
  it("rejects at L1 when same name has different type, emitting a structured log", async () => {
    const embedder = makeFakeEmbedder();
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alice", type: "person", description: "engineer" },
      [candidate({ id: "cand-1", canonicalName: "Alice", type: "company" })],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "type-mismatch",
      level: "L1",
    });
    expect(
      spy.entries.some((e) => e.level === "L1" && e.reason === "type-mismatch")
    ).toBe(true);
  });
});

describe("mergeEntitiesWithGating — L2 description-cosine floor", () => {
  it("rejects at L2 when description cosine is below the 0.30 floor", async () => {
    // Names differ so L0 doesn't fire; types match; descriptions are long
    // and chosen so their cosine is below the floor.
    const descA =
      "completely unrelated topic about rocket manufacturing plants";
    const descB =
      "totally different subject about fine dining and cooking schools";
    const embedder = makeFakeEmbedder({
      [descA]: basisVector(0),
      [descB]: basisVector(1),
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "rocket-co", type: "company", description: descA },
      [
        candidate({
          id: "cand-1",
          canonicalName: "rocket-inc",
          type: "company",
          description: descB,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L2");
    expect(typeof out.decision.observedCosine).toBe("number");
    expect(out.decision.observedCosine!).toBeLessThan(0.3);
    expect(spy.entries.some((e) => e.level === "L2")).toBe(true);
  });

  it("skips L2 when descriptions are shorter than minDescriptionLength, proceeds to L3 without throwing", async () => {
    // Short descriptions → L2 skips. Embedding-text vectors set orthogonal
    // so L3 produces a deterministic gray-zone reject.
    const nameA = "Alice";
    const nameB = "Alicia";
    const descA = "tiny"; // < 8 chars
    const descB = "short"; // < 8 chars
    const embedder = makeFakeEmbedder({
      [`${nameA} | ${descA}`]: basisVector(0),
      [`${nameB} | ${descB}`]: basisVector(1),
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: nameA, type: "person", description: descA },
      [
        candidate({
          id: "cand-1",
          canonicalName: nameB,
          type: "person",
          description: descB,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    // No L2 rejection: L2 was skipped (short descriptions).
    expect(spy.entries.some((e) => e.level === "L2")).toBe(false);
    // L3 ran: orthogonal vectors → below threshold → gray-zone reject.
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L3");
  });
});

describe("mergeEntitiesWithGating — L3 name+description cosine mid threshold", () => {
  it("merges at L3 when name+desc cosine is at/above the 0.50 threshold", async () => {
    // Identical description for both → L2 desc cosine = 1 (passes).
    // Identical embedding-text vectors → L3 cosine = 1 (merges).
    const desc =
      "a long shared description for both entities in this test case";
    const nameA = "Alice";
    const nameB = "Alicia";
    const embedder = makeFakeEmbedder({
      [desc]: basisVector(0),
      [`${nameA} | ${desc}`]: basisVector(0),
      [`${nameB} | ${desc}`]: basisVector(0),
    });
    const out = await mergeEntitiesWithGating(
      { canonicalName: nameA, type: "person", description: desc },
      [
        candidate({
          id: "cand-1",
          canonicalName: nameB,
          type: "person",
          description: desc,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision.kind).toBe("merge");
    if (out.decision.kind !== "merge") return;
    expect(out.decision.via).toBe("L3");
    expect(out.decision.into).toBe("cand-1");
    expect(out.decision.observedCosine).toBeGreaterThanOrEqual(0.5);
  });

  it("rejects at L3 (gray zone) when name+desc cosine is below the 0.50 threshold in single-floor mode", async () => {
    const desc =
      "a long shared description for both entities in this test case";
    const nameA = "Alice";
    const nameB = "Alicia";
    const embedder = makeFakeEmbedder({
      [desc]: basisVector(0), // same → L2 cosine 1, passes L2
      [`${nameA} | ${desc}`]: basisVector(0),
      [`${nameB} | ${desc}`]: basisVector(1), // orthogonal → L3 cosine 0, below 0.50
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: nameA, type: "person", description: desc },
      [
        candidate({
          id: "cand-1",
          canonicalName: nameB,
          type: "person",
          description: desc,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L3");
    expect(spy.entries.some((e) => e.level === "L3")).toBe(true);
  });
});

/**
 * Gray-zone three-level judge. The judge fires ONLY on the L3 gray-zone
 * reject path: the pair below is a shared description (L2 cosine 1) whose
 * L3 name+desc embedding texts are orthogonal (cosine 0 < 0.50 mid).
 */
describe("mergeEntitiesWithGating — gray-zone judge", () => {
  const GRAY_DESC =
    "a long shared description for both entities in this test case";
  const grayIncoming = {
    canonicalName: "Alice",
    type: "person",
    description: GRAY_DESC,
  };
  const grayCandidate = candidate({
    id: "cand-1",
    canonicalName: "Alicia",
    type: "person",
    description: GRAY_DESC,
  });
  const grayEmbedder = () =>
    makeFakeEmbedder({
      [GRAY_DESC]: basisVector(0),
      [`Alice | ${GRAY_DESC}`]: basisVector(0),
      [`Alicia | ${GRAY_DESC}`]: basisVector(1),
    });

  function recordingJudge(
    decide: (input: GrayZoneJudgeInput) => GrayZoneVerdict
  ): { judge: GrayZoneJudge; inputs: GrayZoneJudgeInput[] } {
    const inputs: GrayZoneJudgeInput[] = [];
    const judge: GrayZoneJudge = async (input) => {
      inputs.push(input);
      return decide(input);
    };
    return { judge, inputs };
  }

  async function runGray(
    judge: GrayZoneJudge | undefined,
    ctxExtra: { config?: typeof DEFAULT_MERGE_CONFIG } = {}
  ) {
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      grayIncoming,
      [grayCandidate],
      {
        embedder: grayEmbedder(),
        config: ctxExtra.config ?? DEFAULT_MERGE_CONFIG,
        logGrayZone: spy.fn,
        ...(judge ? { judgeGrayZone: judge } : {}),
      }
    );
    return { out, spy };
  }

  it("L0 exact name+type still merges with zero judge calls", async () => {
    const { judge, inputs } = recordingJudge(() => "reject");
    const out = await mergeEntitiesWithGating(
      { canonicalName: "alice smith", type: "person", description: "engineer" },
      [candidate({ id: "cand-1", canonicalName: "Alice Smith", type: "person" })],
      {
        embedder: makeFakeEmbedder(),
        config: DEFAULT_MERGE_CONFIG,
        judgeGrayZone: judge,
      }
    );
    expect(out.decision).toEqual({
      kind: "merge",
      into: "cand-1",
      via: "L0",
      observedCosine: 1.0,
    });
    expect(inputs).toHaveLength(0);
  });

  it("verdict merge turns the gray reject into an L3 merge and keeps the gray-zone log", async () => {
    const { judge, inputs } = recordingJudge(() => "merge");
    const { out, spy } = await runGray(judge);
    expect(out.decision).toEqual({
      kind: "merge",
      into: "cand-1",
      via: "L3",
      observedCosine: 0,
    });
    expect(out.canonicalId).toBe("cand-1");
    expect(spy.entries).toContainEqual({
      level: "L3",
      observedCosine: 0,
      reason: "gray-zone-below-mid",
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      incoming: {
        name: "Alice",
        type: "person",
        description: GRAY_DESC,
      },
      candidate: {
        name: "Alicia",
        type: "person",
        description: GRAY_DESC,
      },
      observedCosine: 0,
    });
  });

  it("verdict reject keeps the existing gray-zone reject decision unchanged", async () => {
    const { judge, inputs } = recordingJudge(() => "reject");
    const { out, spy } = await runGray(judge);
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "gray-zone-below-mid",
      level: "L3",
      observedCosine: 0,
    });
    expect(inputs).toHaveLength(1);
    expect(spy.entries).toHaveLength(1);
  });

  it("verdict human returns a hold decision naming the gray candidate", async () => {
    const { judge } = recordingJudge(() => "human");
    const { out } = await runGray(judge);
    expect(out.decision).toEqual({ kind: "hold", level: "L3", observedCosine: 0 });
    expect(out.canonicalId).toBe("cand-1");
  });

  it("judge-down (throw) keeps the reject, logs judge-down, and the gray-zone log still fires first", async () => {
    const inputs: GrayZoneJudgeInput[] = [];
    const judge: GrayZoneJudge = async (input) => {
      inputs.push(input);
      throw new Error("judge transport exploded");
    };
    const { out, spy } = await runGray(judge);
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "gray-zone-below-mid",
      level: "L3",
      observedCosine: 0,
    });
    expect(inputs).toHaveLength(1);
    expect(spy.entries.some((e) => e.reason === "gray-zone-below-mid")).toBe(
      true
    );
    // judge-down must be auditable as its own event, not invisible.
    expect(spy.entries).toContainEqual({
      level: "L3",
      observedCosine: 0,
      reason: "judge-down",
    });
  });

  it("never judges a pair the gate would have merged: a later above-floor candidate wins with zero judge calls", async () => {
    // Alicia is gray (cosine 0); Bob's embedding text is the incoming's own
    // vector (cosine 1) so the gate clears the L3 floor before ever needing
    // to take the reject path the judge guards.
    const embedder = makeFakeEmbedder({
      [GRAY_DESC]: basisVector(0),
      [`Alice | ${GRAY_DESC}`]: basisVector(0),
      [`Alicia | ${GRAY_DESC}`]: basisVector(1),
      [`Bob | ${GRAY_DESC}`]: basisVector(0),
    });
    const { judge, inputs } = recordingJudge(() => "merge");
    const out = await mergeEntitiesWithGating(
      grayIncoming,
      [
        grayCandidate,
        candidate({
          id: "cand-bob",
          canonicalName: "Bob",
          type: "person",
          description: GRAY_DESC,
        }),
      ],
      {
        embedder,
        config: DEFAULT_MERGE_CONFIG,
        logGrayZone: graySpy().fn,
        judgeGrayZone: judge,
      }
    );
    expect(inputs).toHaveLength(0);
    expect(out.decision).toEqual({
      kind: "merge",
      into: "cand-bob",
      via: "L3",
      observedCosine: 1,
    });
  });

  it("the judge is consulted once, on the pair the gate finally rejected", async () => {
    const embedder = makeFakeEmbedder({
      [GRAY_DESC]: basisVector(0),
      [`Alice | ${GRAY_DESC}`]: basisVector(0),
      [`Alicia | ${GRAY_DESC}`]: basisVector(1),
      [`Alison | ${GRAY_DESC}`]: basisVector(2),
    });
    const { judge, inputs } = recordingJudge(() => "reject");
    const out = await mergeEntitiesWithGating(
      grayIncoming,
      [
        grayCandidate,
        candidate({
          id: "cand-2",
          canonicalName: "Alison",
          type: "person",
          description: GRAY_DESC,
        }),
      ],
      {
        embedder,
        config: DEFAULT_MERGE_CONFIG,
        logGrayZone: graySpy().fn,
        judgeGrayZone: judge,
      }
    );
    // One call total, for the surviving reject pair — not one per gray pair.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.candidate.name).toBe("Alison");
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "gray-zone-below-mid",
      level: "L3",
      observedCosine: 0,
    });
    expect(out.canonicalId).toBe("cand-2");
  });

  it("bandMode below-low-band candidates are judged too", async () => {
    const config = { ...DEFAULT_MERGE_CONFIG, bandMode: true };
    const { judge, inputs } = recordingJudge(() => "merge");
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      grayIncoming,
      [grayCandidate],
      { embedder: grayEmbedder(), config, logGrayZone: spy.fn, judgeGrayZone: judge }
    );
    expect(spy.entries).toContainEqual({
      level: "L3",
      observedCosine: 0,
      reason: "below-low-band",
    });
    expect(inputs).toHaveLength(1);
    expect(out.decision).toMatchObject({ kind: "merge", via: "L3" });
  });

  it("without a configured judge the gray path is byte-for-byte today's reject", async () => {
    const { out, spy } = await runGray(undefined);
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "gray-zone-below-mid",
      level: "L3",
      observedCosine: 0,
    });
    expect(spy.entries).toHaveLength(1);
  });
});

describe("mergeEntitiesWithGating — created-new", () => {
  it("returns created-new when no candidate matches any gate", async () => {
    const embedder = makeFakeEmbedder();
    const out = await mergeEntitiesWithGating(
      {
        canonicalName: "Zelda",
        type: "person",
        description: "a hero of hyrule",
      },
      [candidate({ id: "cand-1", canonicalName: "Alice", type: "company" })], // type differs → L1 skip; no same-type candidates
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision).toBe("created-new");
  });
});

describe('mergeEntitiesWithGating — candidateSet "all" (SC10)', () => {
  const incoming = {
    canonicalName: "Alice",
    type: "person",
    description: "a software engineer at Acme corp",
  };

  it('rejects with the CandidateSetNotWiredError class when candidateSet is "all"', async () => {
    const embedder = makeFakeEmbedder();
    const err = await mergeEntitiesWithGating(incoming, "all", {
      embedder,
      config: DEFAULT_MERGE_CONFIG,
    }).then(
      (out) => out,
      (e: unknown) => e
    );
    // Asserted by class / name, never by message text.
    expect(err).toBeInstanceOf(CandidateSetNotWiredError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("CandidateSetNotWiredError");
  });

  it('never returns created-new for candidateSet "all" and never touches the embedder', async () => {
    const counting = makeCountingEmbedder();
    await expect(
      mergeEntitiesWithGating(incoming, "all", {
        embedder: counting.embedder,
        config: DEFAULT_MERGE_CONFIG,
      })
    ).rejects.toBeInstanceOf(CandidateSetNotWiredError);
    expect(counting.calls).toHaveLength(0);
  });
});

describe("mergeEntitiesWithGating — L3 stored candidate embedding reuse (SC10)", () => {
  it("does not re-embed a candidate that carries a stored embedding, and embeds the incoming entity once", async () => {
    // Short descriptions → L2 skips, so every embed observed here is L3's.
    const incomingText = "Alicia | tiny";
    const candidateText = "Alice | short";
    const counting = makeCountingEmbedder({
      [incomingText]: basisVector(0),
    });
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alicia", type: "person", description: "tiny" },
      [
        candidate({
          id: "cand-1",
          canonicalName: "Alice",
          type: "person",
          description: "short",
          embedding: basisVector(0),
        }),
      ],
      { embedder: counting.embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(counting.countOf(candidateText)).toBe(0);
    expect(counting.countOf(incomingText)).toBe(1);
    expect(counting.embeddedTexts()).toEqual([incomingText]);
    expect(out.decision).toEqual({
      kind: "merge",
      into: "cand-1",
      via: "L3",
      observedCosine: 1,
    });
  });

  it("embeds the incoming entity once per L3 batch and only the candidates missing a stored embedding", async () => {
    const incomingText = "Alicia | tiny";
    const storedText = "Alice | short";
    const unstoredText = "Alison | brief";
    const counting = makeCountingEmbedder({
      [incomingText]: basisVector(0),
      [unstoredText]: basisVector(1), // orthogonal → gray-zone reject, loop continues
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alicia", type: "person", description: "tiny" },
      [
        candidate({
          id: "cand-unstored",
          canonicalName: "Alison",
          type: "person",
          description: "brief",
        }),
        candidate({
          id: "cand-stored",
          canonicalName: "Alice",
          type: "person",
          description: "short",
          embedding: basisVector(0),
        }),
      ],
      {
        embedder: counting.embedder,
        config: DEFAULT_MERGE_CONFIG,
        logGrayZone: spy.fn,
      }
    );
    expect(counting.countOf(incomingText)).toBe(1);
    expect(counting.countOf(unstoredText)).toBe(1);
    expect(counting.countOf(storedText)).toBe(0);
    expect(out.decision.kind).toBe("merge");
    if (out.decision.kind !== "merge") return;
    expect(out.decision.into).toBe("cand-stored");
    expect(out.decision.via).toBe("L3");
  });

  it("skips a candidate whose stored embedding has a mismatched dimension instead of throwing", async () => {
    const incomingText = "Alicia | tiny";
    const counting = makeCountingEmbedder({
      [incomingText]: basisVector(0),
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alicia", type: "person", description: "tiny" },
      [
        candidate({
          id: "cand-bad-dim",
          canonicalName: "Alice",
          type: "person",
          description: "short",
          embedding: [1, 0, 0], // 3 dims vs the embedder's 8
        }),
      ],
      {
        embedder: counting.embedder,
        config: DEFAULT_MERGE_CONFIG,
        logGrayZone: spy.fn,
      }
    );
    expect(out.decision).toBe("created-new");
    expect(spy.entries.some((e) => e.level === "L3")).toBe(true);
  });

  it("leaves L2 unchanged: description-only embeddings stay transient for a candidate that carries a stored embedding", async () => {
    const descA =
      "completely unrelated topic about rocket manufacturing plants";
    const descB =
      "totally different subject about fine dining and cooking schools";
    const counting = makeCountingEmbedder({
      [descA]: basisVector(0),
      [descB]: basisVector(1),
    });
    const out = await mergeEntitiesWithGating(
      { canonicalName: "rocket-co", type: "company", description: descA },
      [
        candidate({
          id: "cand-1",
          canonicalName: "rocket-inc",
          type: "company",
          description: descB,
          embedding: basisVector(0),
        }),
      ],
      { embedder: counting.embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(counting.countOf(descA)).toBe(1);
    expect(counting.countOf(descB)).toBe(1);
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L2");
  });
});

/**
 * The gates absorb exactly two failure classes — GraphragError (every
 * production embedder failure leg) and RangeError (cosineSimilarity's
 * dimension mismatch) — because both mean "this cosine cannot be proven".
 * Every other class is an unexpected fault and must surface to the caller
 * instead of being laundered into a skipped candidate.
 */
describe("mergeEntitiesWithGating — embed/cosine failure narrowing", () => {
  function throwingEmbedder(err: unknown): Embedder {
    return {
      async embed(): Promise<number[][]> {
        throw err;
      },
    };
  }

  const longDescA =
    "completely unrelated topic about rocket manufacturing plants";
  const longDescB =
    "totally different subject about fine dining and cooking schools";

  /** Long descriptions on both sides ⇒ L2 runs and calls `embedCosine`. */
  function l2Call(embedder: Embedder, logGrayZone?: (e: GrayZoneLog) => void) {
    return mergeEntitiesWithGating(
      { canonicalName: "rocket-co", type: "company", description: longDescA },
      [
        candidate({
          id: "cand-1",
          canonicalName: "rocket-inc",
          type: "company",
          description: longDescB,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone }
    );
  }

  /**
   * Short descriptions ⇒ L2 skips, and the stored candidate embedding means
   * the only embed call is L3's `embedOne` for the incoming entity.
   */
  function l3EmbedOneCall(
    embedder: Embedder,
    logGrayZone?: (e: GrayZoneLog) => void
  ) {
    return mergeEntitiesWithGating(
      { canonicalName: "Alicia", type: "person", description: "tiny" },
      [
        candidate({
          id: "cand-1",
          canonicalName: "Alice",
          type: "person",
          description: "short",
          embedding: basisVector(0),
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone }
    );
  }

  it("L2 skips the candidate when the embedder reports a GraphragError", async () => {
    const spy = graySpy();
    const out = await l2Call(
      throwingEmbedder(new GraphragError("provider down", "EMBEDDING_FAILED")),
      spy.fn
    );
    expect(
      spy.entries.some((e) => e.level === "L2" && e.reason === "embed-failure")
    ).toBe(true);
    expect(out.decision).toBe("created-new");
  });

  it("L2 propagates a non-GraphragError from the embedder", async () => {
    const spy = graySpy();
    await expect(
      l2Call(throwingEmbedder(new TypeError("embed is not a function")), spy.fn)
    ).rejects.toBeInstanceOf(TypeError);
    expect(spy.entries).toEqual([]);
  });

  it("L3 skips the candidate when embedding the incoming entity reports a GraphragError", async () => {
    const spy = graySpy();
    const out = await l3EmbedOneCall(
      throwingEmbedder(
        new GraphragError("dim mismatch", "EMBEDDING_DIM_MISMATCH")
      ),
      spy.fn
    );
    expect(
      spy.entries.some((e) => e.level === "L3" && e.reason === "embed-failure")
    ).toBe(true);
    expect(out.decision).toBe("created-new");
  });

  it("L3 propagates a non-GraphragError raised while embedding the incoming entity", async () => {
    const spy = graySpy();
    await expect(
      l3EmbedOneCall(throwingEmbedder(new RangeError("stack overflow")), spy.fn)
    ).rejects.toBeInstanceOf(RangeError);
    expect(spy.entries).toEqual([]);
  });

  it("L3 propagates a non-RangeError raised by the cosine call itself", async () => {
    // A stored embedding whose `length` read throws is the only way to make
    // cosineSimilarity fail with something other than its own RangeError.
    const hostileEmbedding = {
      get length(): number {
        throw new TypeError("hostile stored embedding");
      },
    } as unknown as number[];
    const embedder = makeFakeEmbedder({
      "Alicia | tiny": basisVector(0),
    });
    await expect(
      mergeEntitiesWithGating(
        { canonicalName: "Alicia", type: "person", description: "tiny" },
        [
          candidate({
            id: "cand-1",
            canonicalName: "Alice",
            type: "person",
            description: "short",
            embedding: hostileEmbedding,
          }),
        ],
        { embedder, config: DEFAULT_MERGE_CONFIG }
      )
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("cosineSimilarity (sanity for the fake embedder)", () => {
  it("scores identical vectors as cosine 1", () => {
    const v = basisVector(2);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("scores orthogonal basis vectors as cosine 0", () => {
    expect(cosineSimilarity(basisVector(0), basisVector(1))).toBeCloseTo(0, 5);
  });
});
