/**
 * Shared read step for the evaluation capability's frozen fixtures.
 *
 * The gold set and the seed corpus fail in the same three ways (absent,
 * blank, not JSON) but must surface DIFFERENT typed errors, so the read
 * is expressed as a plain outcome value and each loader maps it onto its
 * own error class. That keeps one copy of the filesystem handling
 * without collapsing two error taxonomies into one.
 */
import { readFileSync } from "node:fs";

export type FixtureReadFailure = "missing" | "empty" | "malformed";

export type FixtureRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: FixtureReadFailure; detail: string };

/**
 * Read and JSON-parse a fixture. Never throws: every failure comes back
 * as a described outcome so the caller decides which error class the
 * operator sees.
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

/** A non-blank string, or undefined. */
export function asNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : value;
}
