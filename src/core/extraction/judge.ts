/**
 * Grounded judge gate.
 *
 * `judgeProposals` sits between `runExtractMethod` and `persistOutputs` in
 * the chunk transaction: a proposed triple becomes a graph fact ONLY when
 * the judge answers yes for it. The gate is fail-closed — any reject, an
 * empty proposal, a judge that is down (absent adapter, throw/timeout,
 * sealed transport/format failure) is a sealed chunk-level failure the
 * pipeline records and moves past (mark-and-continue). It never throws and
 * never writes: the caller sees a verdict, the graph sees nothing until the
 * proposal passes.
 *
 * Error codes deliberately differ from `SELF_LOOP_REJECTED`: a judge
 * failure CAN be advanced by re-extraction (or promoted by the operator),
 * so both `listFailed()` and the `--only-failed` scan must keep showing it.
 */
import { z } from "zod";

import type { ChunkInput } from "./extract.js";
import { LLM_EXCEPTION_CODE } from "./extract.js";
import { ExtractionOutputSchema, type LLMClient } from "./llm-client.js";
import type {
  ExtractionOutput,
  JudgeResponse,
  TripleVerdict,
} from "./types.js";

/** A proposed triple the judge answered no to (or an empty proposal). */
export const JUDGE_REJECTED_CODE = "JUDGE_REJECTED";
/** The judge could not answer: adapter absent, throw/timeout, transport/format failure. */
export const JUDGE_DOWN_CODE = "JUDGE_DOWN";

/**
 * Spec says timeout == fail, but a hung socket would otherwise lean on
 * undici's transport defaults with no bound the gate controls. The race
 * makes the deadline a property of the gate itself: a judge that cannot
 * answer in time is judged DOWN (fail-closed), never waited on forever.
 */
export const JUDGE_DEADLINE_MS = 60_000;

/** Verdict of the gate: passed (persist proceeds) or sealed chunk failure. */
export type JudgeOutcome =
  | { kind: "passed"; verdicts: TripleVerdict[] }
  | {
      kind: "failed";
      errorCode: string;
      errorMsg: string;
      /** Verdicts collected before/because-of the failure — stored for review. */
      verdicts: TripleVerdict[];
    };

/**
 * Judge every proposed triple of one chunk against the chunk text.
 *
 * The empty proposal is rejected BEFORE any dial: there is nothing to
 * ground, and persisting a zero-output success would hide a model that
 * produced no graph (spec: empty proposal is a reject class).
 */
export async function judgeProposals(
  llm: LLMClient,
  chunk: ChunkInput,
  outputs: ExtractionOutput[],
  opts: { deadlineMs?: number } = {}
): Promise<JudgeOutcome> {
  if (outputs.length === 0) {
    return {
      kind: "failed",
      errorCode: JUDGE_REJECTED_CODE,
      errorMsg: "empty proposal: the extractor proposed no triple to ground",
      verdicts: [],
    };
  }
  if (!llm.judgeGrounding) {
    return {
      kind: "failed",
      errorCode: JUDGE_DOWN_CODE,
      errorMsg: "no judge adapter configured (fail-closed)",
      verdicts: [],
    };
  }
  let response: JudgeResponse;
  const deadlineMs = opts.deadlineMs ?? JUDGE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = llm.judgeGrounding({
      chunkText: chunk.content,
      candidates: outputs,
    });
    // A rejection AFTER the deadline must not become an unhandledRejection.
    call.catch(() => {});
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`judge deadline exceeded after ${deadlineMs}ms`)),
        deadlineMs
      );
      // The gate must not keep a finishing process alive waiting on it.
      timer.unref?.();
    });
    response = await Promise.race([call, deadline]);
  } catch (err) {
    return {
      kind: "failed",
      errorCode: JUDGE_DOWN_CODE,
      errorMsg: `${LLM_EXCEPTION_CODE}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      verdicts: [],
    };
  } finally {
    clearTimeout(timer);
  }
  if (response.kind === "failed") {
    return {
      kind: "failed",
      errorCode: JUDGE_DOWN_CODE,
      errorMsg: `judge down (${response.errorCode}): ${response.errorMsg}`,
      verdicts: [],
    };
  }
  const byIndex = new Map<number, TripleVerdict>();
  for (const verdict of response.verdicts) {
    const seen = byIndex.get(verdict.index);
    // A duplicated index resolves conservatively: any "no" for that
    // candidate rejects it, whatever order the model answered in.
    if (!seen || (!verdict.grounded && seen.grounded)) {
      byIndex.set(verdict.index, verdict);
    }
  }
  const rejected: string[] = [];
  for (let i = 0; i < outputs.length; i += 1) {
    const verdict = byIndex.get(i);
    if (!verdict) {
      // A candidate the judge never answered is a no (fail-closed): silence
      // is not groundedness.
      rejected.push(`[${i}] no verdict`);
    } else if (!verdict.grounded) {
      rejected.push(`[${i}] ${verdict.reason || "judge answered no"}`);
    }
  }
  if (rejected.length > 0) {
    return {
      kind: "failed",
      errorCode: JUDGE_REJECTED_CODE,
      errorMsg: `judge rejected ${rejected.length} of ${outputs.length} triples: ${rejected.join("; ")}`,
      verdicts: outputs.map(
        (_, i) =>
          byIndex.get(i) ?? {
            index: i,
            grounded: false,
            reason: "no verdict",
          }
      ),
    };
  }
  return { kind: "passed", verdicts: outputs.map((_, i) => byIndex.get(i)!) };
}

/**
 * The reviewable payload a judge failure leaves on the record: the FULL
 * proposal plus per-triple verdicts, so the maintenance lane (promote)
 * can replay it without re-dialing the extractor.
 */
export interface ProposalPayload {
  triples: ExtractionOutput[];
  verdicts: TripleVerdict[];
}

/** One stored verdict — the wire `yes`/`no` is already mapped on write. */
const VerdictItemSchema = z.object({
  index: z.number().int().min(0),
  grounded: z.boolean(),
  reason: z.string(),
});

/**
 * Read contract for `proposed_payload` (promote). An empty triple list is
 * refused: the extractor's whole proposal is what promote replays, and a
 * payload without one names a record the judge gate should never have sealed
 * this way.
 */
export const ProposalPayloadSchema = z.object({
  triples: z.array(ExtractionOutputSchema).min(1),
  verdicts: z.array(VerdictItemSchema),
});
