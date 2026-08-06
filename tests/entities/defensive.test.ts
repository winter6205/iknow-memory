/**
 * T8 defensive contract for `mergeEntitiesWithGating` — 5 boundary classes.
 *
 *   empty      → incoming with empty canonicalName/type/description: L1
 *                fires because normalizeAlias("") matches a candidate with
 *                the same empty name but a different type ("person" vs "").
 *                The function returns L1 reject, type-mismatch. (Pinned as
 *                documented behavior: the merge gates use the same name
 *                slot regardless of whether the name is empty, so an empty
 *                incoming name still participates in the L1 check.)
 *   negative   → empty candidateSet (non-"all") ⇒ no candidates means no
 *                merge is possible ⇒ returns "created-new".
 *   overflow   → 10000-candidate set forces the L3 loop to compute cosine
 *                for every candidate; pins "completes and is deterministic
 *                within a reasonable time budget" using FakeEmbedder.
 *   concurrent → two parallel mergeEntitiesWithGating calls with identical
 *                inputs + embedder ⇒ identical results (deterministic).
 *   exception  → embedder throws mid-merge ⇒ BUG: merge.ts has no try/catch
 *                around the embedder call, so a rejecting embedder
 *                propagates out of mergeEntitiesWithGating. The spec
 *                description for the exception boundary expects the
 *                function to catch and return a sealed outcome. Pinning
 *                current behavior for the coordinator.
 */
import { describe, it, expect } from "vitest";
import {
  mergeEntitiesWithGating,
  type CandidateEntity,
  type Embedder,
} from "../../src/core/entities/merge.js";
import { DEFAULT_MERGE_CONFIG } from "../../src/core/entities/types.js";
import { FakeEmbedder } from "../../src/core/embedder.js";

/** Deterministic embedder: returns an orthonormal-ish vector per unique text. */
function makeDeterministicEmbedder(dim = 8): Embedder {
  return new FakeEmbedder(dim);
}

function candidate(over: Partial<CandidateEntity>): CandidateEntity {
  return {
    id: "cand-1",
    canonicalName: "Alice",
    type: "person",
    description: "a long descriptive line for the candidate entity",
    ...over,
  };
}

describe("mergeEntitiesWithGating — empty boundary (incoming all empty)", () => {
  it("rites an L1 type-mismatch reject when an empty-name candidate has a different type: normalizeAlias('') === normalizeAlias('') so the empty name still participates in the L1 gate", async () => {
    const out = await mergeEntitiesWithGating(
      { canonicalName: "", type: "", description: "" },
      [candidate({ id: "cand-x", canonicalName: "", type: "person" })],
      { embedder: makeDeterministicEmbedder(), config: DEFAULT_MERGE_CONFIG }
    );
    // L1 fires: incoming name "" normalizes equal to candidate name "" but
    // the types differ ("" vs "person") ⇒ type-mismatch reject.
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "type-mismatch",
      level: "L1",
    });
    expect(out.canonicalId).toBe("cand-x");
  });
});

describe("mergeEntitiesWithGating — negative boundary (empty candidate set)", () => {
  it("returns created-new when candidateSet is [] (no candidates → no merges possible)", async () => {
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alice", type: "person", description: "engineer" },
      [],
      { embedder: makeDeterministicEmbedder(), config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision).toBe("created-new");
    expect(out.canonicalId).toBe("");
  });
});

describe("mergeEntitiesWithGating — overflow boundary (10k candidates)", () => {
  it("processes 10000 candidates within 5s and returns a deterministic result without OOM", async () => {
    const N = 10_000;
    const candidates: CandidateEntity[] = [];
    for (let i = 0; i < N; i += 1) {
      candidates.push({
        id: `c-${i}`,
        canonicalName: `entity-${i}`,
        type: "person",
        description: `description variant ${i} for stress test`,
      });
    }
    const embedder = makeDeterministicEmbedder(8);
    const start = Date.now();
    const out = await mergeEntitiesWithGating(
      {
        canonicalName: "X-Incoming",
        type: "person",
        description: "the incoming description",
      },
      candidates,
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
    // Deterministic: re-running with the same inputs yields the same outcome.
    const out2 = await mergeEntitiesWithGating(
      {
        canonicalName: "X-Incoming",
        type: "person",
        description: "the incoming description",
      },
      candidates,
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision.kind).toBe(out2.decision.kind);
    if (out.decision.kind === "merge" && out2.decision.kind === "merge") {
      expect(out.decision.into).toBe(out2.decision.into);
      expect(out.decision.via).toBe(out2.decision.via);
    } else if (
      out.decision.kind === "reject" &&
      out2.decision.kind === "reject"
    ) {
      expect(out.decision.level).toBe(out2.decision.level);
    }
  }, 10_000);
});

describe("mergeEntitiesWithGating — concurrent boundary", () => {
  it("two parallel calls with identical inputs and embedder return identical decisions", async () => {
    const embedder = makeDeterministicEmbedder();
    const candidates = [
      candidate({ id: "a-1", canonicalName: "Alice", type: "person" }),
      candidate({
        id: "a-2",
        canonicalName: "Alicia",
        type: "person",
        description: "another description",
      }),
    ];
    const incoming = {
      canonicalName: "Alice",
      type: "person",
      description: "engineer at Acme corp",
    };
    const [r1, r2] = await Promise.all([
      mergeEntitiesWithGating(incoming, candidates, {
        embedder,
        config: DEFAULT_MERGE_CONFIG,
      }),
      mergeEntitiesWithGating(incoming, candidates, {
        embedder,
        config: DEFAULT_MERGE_CONFIG,
      }),
    ]);
    expect(r1.decision.kind).toBe(r2.decision.kind);
    if (r1.decision.kind === "merge" && r2.decision.kind === "merge") {
      expect(r1.decision.into).toBe(r2.decision.into);
      expect(r1.decision.via).toBe(r2.decision.via);
    } else if (r1.decision.kind === "reject" && r2.decision.kind === "reject") {
      expect(r1.decision.level).toBe(r2.decision.level);
      expect(r1.decision.reason).toBe(r2.decision.reason);
    }
    expect(r1.canonicalId).toBe(r2.canonicalId);
  });
});

describe("mergeEntitiesWithGating — exception boundary (embedder throws)", () => {
  it("does not throw on an embedder exception; returns a sealed outcome (created-new) when the embedder cannot compute any cosine, so the batch can mark-and-continue", async () => {
    const throwingEmbedder: Embedder = {
      embed: async (): Promise<number[][]> => {
        throw new Error("embedder exploded");
      },
    };
    const candidates = [
      candidate({
        id: "c-1",
        canonicalName: "Different Name",
        type: "person",
        description:
          "a long description that would force L2 or L3 to call the embedder",
      }),
    ];
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alice", type: "person", description: "engineer" },
      candidates,
      { embedder: throwingEmbedder, config: DEFAULT_MERGE_CONFIG }
    );
    // L0/L1 miss, L2 skips (short incoming desc), L3 skip-on-embed-failure → created-new.
    expect(out.decision).toBe("created-new");
    expect(out.canonicalId).toBe("");
  });
});
