/**
 * Shared read step for the extraction-eval capability's frozen fixtures.
 *
 * Self-contained on purpose: the retrieve harness has a look-alike
 * helper, but sharing it would couple two capabilities that are frozen
 * on different schedules and raise different typed errors. The read is
 * expressed as a plain outcome value so each loader maps it onto its own
 * error class instead of collapsing two taxonomies into one.
 */
import { readFileSync } from "node:fs";

export type FixtureReadFailure = "missing" | "empty" | "malformed";

export type FixtureRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: FixtureReadFailure; detail: string };

/**
 * Read and JSON-parse a fixture. Never throws: every failure comes back
 * as a described outcome so the caller decides which error the operator
 * sees.
 */
export function readJsonFixture(path: string): FixtureRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // EXIT: 以 outcome 上行，由调用方转成点名 fixture 的 typed error
    return {
      ok: false,
      reason: "missing",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (text.trim() === "") {
    return { ok: false, reason: "empty", detail: "file holds no content" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    // EXIT: 同上 —— 解析失败不静默降级为空 fixture
    return {
      ok: false,
      reason: "malformed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Narrow an unknown JSON value to a plain object, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** A string with non-blank content, returned verbatim, or undefined. */
export function asNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}
