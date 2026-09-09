/**
 * JSON + error envelope. Handlers never build `{ error }` by hand.
 */
import { redactDiagnostic } from "../logging.js";

export type DashboardErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "STORAGE_ERROR"
  | "RETRIEVAL_FAILED"
  | "NEO4J_UNAVAILABLE"
  | "INTERNAL";

export function errorEnvelope(
  code: DashboardErrorCode,
  err: unknown
): { error: { code: DashboardErrorCode; message: string } } {
  const raw = err instanceof Error ? err.message : String(err);
  return { error: { code, message: redactDiagnostic(raw) } };
}

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}
