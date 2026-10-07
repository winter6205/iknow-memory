/**
 * The memory lane of MP12's serving guard.
 *
 * The point of the twin is that the two lanes answer the SAME question the same
 * way, so every case here is one the SQL aggregate could plausibly get wrong —
 * a source with one live and one collected version is the one, because a naive
 * `bool_and` over the wrong column would drop it. Withdrawal is the second:
 * `max(sv.retired_at)` and "the first non-null `retiredAt`" are different
 * aggregations, and the memory twin can only be a faithful copy if the
 * aggregation is part of the asserted contract rather than an accident.
 */
import { describe, expect, it } from "vitest";

import { MemoryServingGuard } from "../../src/core/storage/serving-guard-memory.js";

describe("MP12 memory lane", () => {
  it("serves a source whose current version is live beside a retired one", () => {
    const guard = new MemoryServingGuard([
      { sourceRef: "a", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: null },
    ]);
    expect(guard.guard(["a"])).toEqual({ served: true, dropped: [] });
  });

  it("drops a source only once EVERY version's payload is collected", () => {
    const guard = new MemoryServingGuard([
      { sourceRef: "a", payloadCollectedAt: "2026-02-01T00:00:00.000Z" },
      { sourceRef: "a", payloadCollectedAt: "2026-03-01T00:00:00.000Z" },
    ]);
    const verdict = guard.guard(["a"]);
    if (!verdict.served) throw new Error("expected a verdict");
    expect(verdict.dropped).toEqual(["a"]);
  });

  it("keeps a source when one of several versions is still live", () => {
    const guard = new MemoryServingGuard([
      { sourceRef: "a", payloadCollectedAt: "2026-02-01T00:00:00.000Z" },
      { sourceRef: "a", payloadCollectedAt: null },
    ]);
    expect(guard.guard(["a"])).toEqual({ served: true, dropped: [] });
  });

  it("refuses a source it has no version for, the same way the SQL leaves it absent", () => {
    const guard = new MemoryServingGuard([{ sourceRef: "a" }]);
    const verdict = guard.guard(["ghost"]);
    expect(verdict.served).toBe(false);
    if (verdict.served) return;
    expect(verdict.code).toBe("maintenance_status_unavailable");
  });

  it("serves an empty candidate set without reading anything", () => {
    const guard = new MemoryServingGuard([{ sourceRef: "a" }]);
    expect(guard.guard([])).toEqual({ served: true, dropped: [] });
  });
});

describe("MP12 memory lane — withdrawal", () => {
  it("drops a withdrawn source whose payload was never collected", () => {
    const guard = new MemoryServingGuard([{ sourceRef: "a", active: false }]);
    const verdict = guard.guard(["a"]);
    if (!verdict.served) throw new Error("expected a verdict");
    expect(verdict.dropped).toEqual(["a"]);
  });

  it("keeps serving a source with no publication row, because ingested is not withdrawn", () => {
    const guard = new MemoryServingGuard([{ sourceRef: "a" }]);
    expect(guard.guard(["a"])).toEqual({ served: true, dropped: [] });
  });
});

describe("MP12 memory lane — the facts mirror the SQL aggregate", () => {
  it("reports the LATEST retirement, so seeding order cannot change the answer", () => {
    // `max(sv.retired_at)`, not "the first non-null one". Order-independence is
    // the property: a first-non-null read answers a different question and
    // diverges from the SQL lane the moment the seed order changes.
    const earliest = new MemoryServingGuard([
      { sourceRef: "a", retiredAt: "2026-01-01T00:00:00.000Z" },
      { sourceRef: "a", retiredAt: "2026-03-01T00:00:00.000Z" },
      { sourceRef: "a", retiredAt: "2026-02-01T00:00:00.000Z" },
    ]);
    const shuffled = new MemoryServingGuard([
      { sourceRef: "a", retiredAt: "2026-02-01T00:00:00.000Z" },
      { sourceRef: "a", retiredAt: "2026-03-01T00:00:00.000Z" },
      { sourceRef: "a", retiredAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(earliest.factsFor(["a"])?.get("a")?.retiredAt).toBe(
      "2026-03-01T00:00:00.000Z"
    );
    expect(shuffled.factsFor(["a"])).toEqual(earliest.factsFor(["a"]));
  });
});
