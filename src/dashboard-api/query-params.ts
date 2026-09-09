/**
 * Query-string parsing for dashboard-api handlers.
 */
import { GraphragError } from "../core/errors.js";

function invalid(message: string): GraphragError {
  return new GraphragError(message, "INVALID_INPUT");
}

export function parsePagination(
  raw: string | null,
  fallback: number,
  max: number
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw invalid(`limit must be an integer in 1..${max}, got "${raw}"`);
  }
  if (value > max) {
    throw invalid(`limit exceeds maximum ${max}, got "${raw}"`);
  }
  return value;
}

/** Offset: default 0; must be a non-negative integer (0 is valid). */
export function parseOffset(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`offset must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export function requireText(raw: string | null, name: string): string {
  if (raw === null || raw.trim() === "") {
    throw invalid(`${name} is required and must be non-empty`);
  }
  return raw;
}

export function optionalEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  name: string
): T | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw as T;
  if (!allowed.includes(value)) {
    throw invalid(
      `${name} must be one of ${allowed.join(" | ")}, got "${raw}"`
    );
  }
  return value;
}

export function readQueryParams(rawQuery: string): URLSearchParams {
  return new URLSearchParams(
    rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery
  );
}
