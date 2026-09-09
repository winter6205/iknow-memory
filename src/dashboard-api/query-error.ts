/**
 * Retrieval errors → HTTP. Never remap all-arms-failed to 200 [].
 */
import type { DashboardErrorCode } from "./responses.js";
import { GraphragError } from "../core/errors.js";

export interface RetrievalErrorDescriptor {
  status: number;
  code: DashboardErrorCode;
}

export function retrievalErrorStatus(err: unknown): RetrievalErrorDescriptor {
  if (err instanceof GraphragError) {
    return err.code === "INVALID_INPUT"
      ? { status: 400, code: "INVALID_INPUT" }
      : { status: 503, code: "RETRIEVAL_FAILED" };
  }
  return { status: 500, code: "INTERNAL" };
}
