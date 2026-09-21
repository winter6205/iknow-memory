/**
 * Unit tests for the grounded judge gate (extract-verify T1).
 *
 * `judgeProposals` sits between `runExtractMethod` and `persistOutputs`:
 * a chunk becomes a graph fact set only when the judge answers yes for
 * EVERY proposed triple. Any reject, an empty proposal, or a judge that is
 * down (absent adapter, throw/timeout, transport failure) is a sealed
 * chunk-level failure — the helper never throws.
 */
import { describe, it, expect } from "vitest";

import {
  judgeProposals,
  JUDGE_DOWN_CODE,
  JUDGE_REJECTED_CODE,
} from "../../src/core/extraction/judge.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { LLMClient } from "../../src/core/extraction/llm-client.js";
import type {
  ExtractionOutput,
  JudgeResponse,
} from "../../src/core/extraction/types.js";
import type { ChunkInput } from "../../src/core/extraction/extract.js";

const CHUNK: ChunkInput = {
  id: "chunk-1",
  content: "Alice works at Acme Corp. Bob founded Beta GmbH.",
};

const TRIPLE_A: ExtractionOutput = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alice works at Acme Corp",
  evidenceSpan: "Alice works at Acme Corp",
  confidence: 0.9,
};

const TRIPLE_B: ExtractionOutput = {
  head: "Bob",
  headType: "person",
  relationRaw: "founded",
  relationNorm: "FOUNDED",
  tail: "Beta GmbH",
  tailType: "organization",
  description: "Bob founded Beta GmbH",
  evidenceSpan: "Bob founded Beta GmbH",
  confidence: 0.8,
};

function allYes(input: {
  candidates: ExtractionOutput[];
}): Promise<JudgeResponse> {
  return Promise.resolve({
    kind: "ok",
    verdicts: input.candidates.map((_, index) => ({
      index,
      grounded: true,
      reason: "stated in the chunk",
    })),
  });
}

describe("judgeProposals", () => {
  it("passes when every proposed triple is judged grounded", async () => {
    const llm = new FakeLLMClient({ queue: [], scriptedJudge: allYes });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A, TRIPLE_B]);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.verdicts).toHaveLength(2);
    expect(outcome.verdicts.every((v) => v.grounded)).toBe(true);
  });

  it("one grounded=no verdict fails the chunk with JUDGE_REJECTED + reason", async () => {
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async () => ({
        kind: "ok",
        verdicts: [
          { index: 0, grounded: true, reason: "stated" },
          { index: 1, grounded: false, reason: "tail not in chunk" },
        ],
      }),
    });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A, TRIPLE_B]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_REJECTED_CODE);
    expect(outcome.errorMsg).toContain("tail not in chunk");
    // The verdicts travel with the failure so the record payload is reviewable.
    expect(outcome.verdicts).toHaveLength(2);
  });

  it("a duplicated index resolves conservatively: yes-then-no still rejects", async () => {
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async () => ({
        kind: "ok",
        verdicts: [
          { index: 0, grounded: true, reason: "stated" },
          { index: 0, grounded: false, reason: "second thought: not stated" },
          { index: 1, grounded: true, reason: "stated" },
        ],
      }),
    });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A, TRIPLE_B]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_REJECTED_CODE);
    expect(outcome.errorMsg).toContain("second thought: not stated");
  });

  it("a missing verdict for a candidate is treated as a reject (fail-closed)", async () => {
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async () => ({
        kind: "ok",
        verdicts: [{ index: 0, grounded: true, reason: "stated" }],
      }),
    });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A, TRIPLE_B]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_REJECTED_CODE);
  });

  it("an empty proposal is a reject-class failure and never dials the judge", async () => {
    let judgeCalls = 0;
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async (input) => {
        judgeCalls += 1;
        return allYes(input);
      },
    });
    const outcome = await judgeProposals(llm, CHUNK, []);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_REJECTED_CODE);
    expect(outcome.errorMsg).toContain("empty proposal");
    expect(judgeCalls).toBe(0);
  });

  it("a client without the judge adapter fails closed with JUDGE_DOWN", async () => {
    const llm = {
      extract: async () => ({ kind: "ok", outputs: [] }),
    } as unknown as LLMClient;
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_DOWN_CODE);
  });

  it("a judge that throws (e.g. timeout) is JUDGE_DOWN, not a crash", async () => {
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async () => {
        throw new Error("request timed out");
      },
    });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_DOWN_CODE);
    expect(outcome.errorMsg).toContain("timed out");
  });

  it("a judge that hangs past the deadline is JUDGE_DOWN (timeout == fail)", async () => {
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: () =>
        new Promise<JudgeResponse>((resolve) =>
          setTimeout(
            () =>
              resolve({
                kind: "ok",
                verdicts: [{ index: 0, grounded: true, reason: "too late" }],
              }),
            200
          )
        ),
    });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A], {
      deadlineMs: 10,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_DOWN_CODE);
    expect(outcome.errorMsg).toContain("deadline exceeded");
  });

  it("a judge that answers inside the deadline still passes", async () => {
    const llm = new FakeLLMClient({ queue: [], scriptedJudge: allYes });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A], {
      deadlineMs: 5_000,
    });
    expect(outcome.kind).toBe("passed");
  });

  it("a sealed transport/format failure from the judge is JUDGE_DOWN", async () => {
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async () => ({
        kind: "failed",
        errorCode: "5xx",
        errorMsg: "upstream 500",
      }),
    });
    const outcome = await judgeProposals(llm, CHUNK, [TRIPLE_A]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe(JUDGE_DOWN_CODE);
    expect(outcome.errorMsg).toContain("upstream 500");
  });
});
