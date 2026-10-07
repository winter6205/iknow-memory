/**
 * MP12 serving guards — the rule, and the direction it fails in.
 *
 * The cases that matter are the ones where serving anyway is tempting: a source
 * that is retired but whose sibling version is live, a source that is gone from
 * the facts map entirely, and lifecycle state that could not be read at all.
 */
import { describe, expect, it } from "vitest";

import { decideServingGuard } from "../../src/core/structured/serving-guard.js";
import type { SourceLifecycleFacts } from "../../src/core/structured/serving-guard.js";

const facts = (entries: Record<string, string | null>): SourceLifecycleFacts => {
  const map = new Map<string, { sourceRef: string; retiredAt: string | null; payloadCollectedAt: string | null }>();
  for (const [sourceRef, payloadCollectedAt] of Object.entries(entries)) {
    map.set(sourceRef, { sourceRef, retiredAt: null, payloadCollectedAt });
  }
  return map;
};

const live = facts({ a: null, b: null });
const purged = facts({ a: null, b: "collected" });

describe("MP12 — a source is served while any version is live", () => {
  it("serves and drops nothing when every candidate is live", () => {
    expect(decideServingGuard(["a", "b"], live)).toEqual({ served: true, dropped: [] });
  });

  it("drops a sole-purged source and keeps a live one beside it", () => {
    const verdict = decideServingGuard(["a", "b"], purged);
    expect(verdict.served).toBe(true);
    if (!verdict.served) return;
    expect(verdict.dropped).toEqual(["b"]);
  });

  it("keeps a retired source visible, because retirement is not collection", () => {
    const retiredOnly: SourceLifecycleFacts = new Map([
      ["a", { sourceRef: "a", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: null }],
    ]);
    expect(decideServingGuard(["a"], retiredOnly)).toEqual({ served: true, dropped: [] });
  });

  it("collapses duplicates, so one stale row drops its source exactly once", () => {
    const verdict = decideServingGuard(["b", "b", "a"], purged);
    if (!verdict.served) throw new Error("expected a verdict");
    expect(verdict.dropped).toEqual(["b"]);
  });
});

describe("MP12 — unknown is not the same as dead", () => {
  it("refuses when the lifecycle could not be read at all", () => {
    const verdict = decideServingGuard(["a"], null);
    expect(verdict.served).toBe(false);
    if (verdict.served) return;
    expect(verdict.code).toBe("maintenance_status_unavailable");
  });

  it("refuses when one candidate source is missing from the facts", () => {
    const verdict = decideServingGuard(["a", "ghost"], live);
    expect(verdict.served).toBe(false);
    if (verdict.served) return;
    expect(verdict.code).toBe("maintenance_status_unavailable");
    // The detail names the source, so an operator can find which one.
    expect(verdict.detail).toContain("ghost");
  });

  it("refuses a source the store has no version row for — the purged-identity case", () => {
    const verdict = decideServingGuard(["gone"], new Map());
    expect(verdict.served).toBe(false);
    if (verdict.served) return;
    expect(verdict.detail).toContain("no lifecycle state");
  });
});

describe("MP12 — an empty candidate set is served", () => {
  it("serves nothing to guard, rather than refusing every unattributable result", () => {
    expect(decideServingGuard([], null)).toEqual({ served: true, dropped: [] });
  });
});
