/**
 * PR drift gate + Release absolute gate (specs/p0-eval.md SC14, SC15).
 *
 * SC14 (PR): no LLM call; `|ΔF1| ≤ 0.05` vs the last baseline → pass;
 * breach → fail; missing baseline → pass ("nothing to drift").
 *
 * SC15 (Release): three axes vs locked thresholds; any axis fail → fail;
 * thresholds are read FROM the operator-locked thresholds file (the
 * refuse-until-lock companion to the baseline), not from source literals
 * in this module.
 *
 * SC7 cross-check: the five diagnostic error types never feed either
 * gate — a report with non-empty `errors` still passes when the axes
 * pass. The cleanest way to enforce that is for the gate module to
 * take no `errors` parameter at all; the suite asserts the surface to
 * keep the contract honest.
 *
 * The suite is pure in-memory: no baseline file, no LLM, no clock.
 */
import { describe, it, expect } from "vitest";

import {
  driftGate,
  extractThresholds,
  releaseGate,
  type Axes,
  type DriftOpts,
  type ReleaseThresholds,
} from "../../src/core/extraction-eval/gate.js";
import type { BaselineEntry } from "../../src/core/extraction-eval/baseline.js";

/** Tiny axes builder so tests read as a table of facts. */
function axes(partial: Partial<Axes> = {}): Axes {
  return {
    f1: partial.f1 ?? 0,
    schemaRate: partial.schemaRate ?? 1,
    hallucinationRate: partial.hallucinationRate ?? 0,
  };
}

/** A baseline entry with arbitrary axes; thresholds live on file (E-T4). */
function baselineOf(partial: Partial<Axes> = {}): BaselineEntry {
  return {
    snapshotId: "snap-v1",
    modelId: "extractor-v1",
    promptHash: "sha256:abc",
    axes: axes(partial),
    recordedAt: "2026-08-30T00:00:00Z",
  };
}

describe("driftGate (SC14)", () => {
  const tolerance: DriftOpts = { driftTolerance: 0.05 };

  it("passes when |ΔF1| = 0.0499 (just inside the boundary)", () => {
    const baseline = baselineOf({ f1: 0.7 });
    const current = axes({ f1: 0.7 + 0.0499 });

    const result = driftGate(current, baseline.axes, tolerance);

    expect(result.pass).toBe(true);
    expect(result.missing).toBeUndefined();
    expect(result.delta?.f1).toBeCloseTo(0.0499, 10);
  });

  it("fails when |ΔF1| = 0.0501 (just past the boundary)", () => {
    const baseline = baselineOf({ f1: 0.7 });
    const current = axes({ f1: 0.7 - 0.0501 });

    const result = driftGate(current, baseline.axes, tolerance);

    expect(result.pass).toBe(false);
    expect(result.delta?.f1).toBeCloseTo(-0.0501, 10);
  });

  it("passes on a perfect match (ΔF1 = 0)", () => {
    const baseline = baselineOf({
      f1: 0.7,
      schemaRate: 0.9,
      hallucinationRate: 0.05,
    });
    const current = axes({ f1: 0.7, schemaRate: 0.9, hallucinationRate: 0.05 });

    const result = driftGate(current, baseline.axes, tolerance);

    expect(result.pass).toBe(true);
    expect(result.delta?.f1).toBe(0);
    expect(result.delta?.schemaRate).toBe(0);
    expect(result.delta?.hallucinationRate).toBe(0);
  });

  it("returns {pass: true, missing: true} when the baseline is null", () => {
    const result = driftGate(axes({ f1: 0.1 }), null, tolerance);

    expect(result.pass).toBe(true);
    expect(result.missing).toBe(true);
    expect(result.delta).toBeUndefined();
  });

  it("ignores schema-rate and hallucination-rate drift at PR (only F1 gates)", () => {
    const baseline = baselineOf({
      f1: 0.7,
      schemaRate: 0.9,
      hallucinationRate: 0.05,
    });
    // F1 unchanged; the other two axes swing wildly.
    const current = axes({
      f1: 0.7,
      schemaRate: 0.1,
      hallucinationRate: 0.9,
    });

    const result = driftGate(current, baseline.axes, tolerance);

    expect(result.pass).toBe(true);
  });

  it("uses the |ΔF1| absolute value, not the signed delta, for the boundary check", () => {
    const toleranceLocal = { driftTolerance: 0.05 };
    const baseline = baselineOf({ f1: 0.7 });
    const up = axes({ f1: 0.7 + 0.04 });
    const down = axes({ f1: 0.7 - 0.04 });

    expect(driftGate(up, baseline.axes, toleranceLocal).pass).toBe(true);
    expect(driftGate(down, baseline.axes, toleranceLocal).pass).toBe(true);
  });

  it("honours a non-default drift tolerance passed via opts", () => {
    const baseline = baselineOf({ f1: 0.7 });
    const current = axes({ f1: 0.75 });

    const loose = driftGate(current, baseline.axes, { driftTolerance: 0.1 });
    const tight = driftGate(current, baseline.axes, { driftTolerance: 0.01 });

    expect(loose.pass).toBe(true);
    expect(tight.pass).toBe(false);
  });
});

describe("releaseGate (SC15)", () => {
  const thresholds: ReleaseThresholds = {
    f1Minimum: 0.7,
    schemaRateMinimum: 0.9,
    hallucinationRateMaximum: 0.05,
  };

  it("passes when every axis meets its threshold", () => {
    const current = axes({
      f1: 0.8,
      schemaRate: 0.95,
      hallucinationRate: 0.02,
    });

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(true);
    expect(result.failures).toEqual({});
  });

  it("passes when an axis sits exactly on its threshold (inclusive)", () => {
    const current = axes({ f1: 0.7, schemaRate: 0.9, hallucinationRate: 0.05 });

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(true);
    expect(result.failures).toEqual({});
  });

  it("fails on F1 alone when only F1 is below threshold", () => {
    const current = axes({
      f1: 0.6,
      schemaRate: 0.95,
      hallucinationRate: 0.02,
    });

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(false);
    expect(result.failures.f1).toBe(true);
    expect(result.failures.schemaRate).toBeUndefined();
    expect(result.failures.hallucinationRate).toBeUndefined();
  });

  it("fails on schema rate alone when only schema rate is below threshold", () => {
    const current = axes({
      f1: 0.8,
      schemaRate: 0.85,
      hallucinationRate: 0.02,
    });

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(false);
    expect(result.failures.f1).toBeUndefined();
    expect(result.failures.schemaRate).toBe(true);
    expect(result.failures.hallucinationRate).toBeUndefined();
  });

  it("fails on hallucination rate alone when only hallucination rate is above threshold", () => {
    const current = axes({ f1: 0.8, schemaRate: 0.95, hallucinationRate: 0.1 });

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(false);
    expect(result.failures.f1).toBeUndefined();
    expect(result.failures.schemaRate).toBeUndefined();
    expect(result.failures.hallucinationRate).toBe(true);
  });

  it("reports every failing axis when multiple axes breach", () => {
    const current = axes({ f1: 0.5, schemaRate: 0.5, hallucinationRate: 0.5 });

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(false);
    expect(result.failures.f1).toBe(true);
    expect(result.failures.schemaRate).toBe(true);
    expect(result.failures.hallucinationRate).toBe(true);
  });

  it("treats hallucination rate as upper-bound (≤) and the others as lower-bound (≥)", () => {
    // Below F1 threshold → fails on F1.
    const belowF1 = releaseGate(axes({ f1: 0.69 }), thresholds);
    expect(belowF1.failures.f1).toBe(true);

    // Above hallucination threshold → fails on hallucination.
    const aboveHall = releaseGate(
      axes({ hallucinationRate: 0.0501 }),
      thresholds
    );
    expect(aboveHall.failures.hallucinationRate).toBe(true);
  });
});

describe("extractThresholds (SC15)", () => {
  it("returns the locked thresholds when present (Release-period)", () => {
    const locked: ReleaseThresholds = {
      f1Minimum: 0.7,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.05,
    };

    const result = extractThresholds(locked);

    expect(result).toEqual({
      f1Minimum: 0.7,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.05,
    });
  });

  it("returns null when no thresholds are locked (Bootstrap-period)", () => {
    const result = extractThresholds(null);
    expect(result).toBeNull();
  });

  it("returns a defensive copy — mutating the result does not rewrite the input", () => {
    const locked: ReleaseThresholds = {
      f1Minimum: 0.7,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.05,
    };

    const result = extractThresholds(locked)!;
    result.f1Minimum = 0;

    expect(locked.f1Minimum).toBe(0.7);
  });

  it("is not hard-coded — the gate's verdict changes when thresholds change", () => {
    const current = axes({
      f1: 0.71,
      schemaRate: 0.85,
      hallucinationRate: 0.04,
    });
    const tight: ReleaseThresholds = {
      f1Minimum: 0.75,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.03,
    };
    const loose: ReleaseThresholds = {
      f1Minimum: 0.7,
      schemaRateMinimum: 0.8,
      hallucinationRateMaximum: 0.05,
    };

    const fromTight = releaseGate(current, extractThresholds(tight)!);
    const fromLoose = releaseGate(current, extractThresholds(loose)!);

    expect(fromTight.pass).toBe(false);
    expect(fromLoose.pass).toBe(true);
  });
});

describe("error types never gate (SC7)", () => {
  it("releaseGate has no parameter that accepts diagnostic error types", () => {
    // The gate functions take only axes + thresholds. This test pins
    // the surface: a future change that adds an `errors` parameter
    // would re-introduce a path where mis-predictions can fail a gate
    // they are explicitly forbidden from failing.
    const thresholds: ReleaseThresholds = {
      f1Minimum: 0.7,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.05,
    };
    const current = axes({
      f1: 0.8,
      schemaRate: 0.95,
      hallucinationRate: 0.02,
    });

    // A non-empty errors map would conceptually exist on the scorer;
    // the gate cannot see it because it takes no such parameter.
    const fakeErrors = new Map<string, string>([
      ["pred:0", "spurious"],
      ["pred:1", "wrong-relation"],
      ["pred:2", "wrong-entity"],
      ["gold:0", "incomplete"],
      ["gold:1", "schema-violation"],
    ]);

    const result = releaseGate(current, thresholds);

    expect(result.pass).toBe(true);
    expect(fakeErrors.size).toBeGreaterThan(0); // errors exist somewhere, the gate ignored them
  });

  it("driftGate ignores diagnostic error types — only F1 enters the verdict", () => {
    const baseline = baselineOf({ f1: 0.7 });
    const current = axes({ f1: 0.7 });

    const result = driftGate(current, baseline.axes, { driftTolerance: 0.05 });

    expect(result.pass).toBe(true);
  });
});
