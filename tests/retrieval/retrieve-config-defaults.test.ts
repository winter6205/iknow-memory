/**
 * Default retrieve-config SSOT tests (review repair I1).
 *
 * The balanced fusion defaults used to exist as three verbatim literals
 * (retrieve.ts `applyPreset` / `applyWaitOverrides` and mode-c-arm's
 * fallback). The dedup into DEFAULT_RETRIEVE_CONFIG /
 * retrieveConfigForPreset must not move ANY value, so this file pins the
 * exact former literals field by field.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETRIEVE_CONFIG,
  RETRIEVE_PRESETS,
  RETRIEVE_PRESET_BUNDLES,
  retrieveConfigForPreset,
} from "../../src/core/retrieval/types.js";

describe("DEFAULT_RETRIEVE_CONFIG (I1 SSOT)", () => {
  it("pins the exact former hand-written default literal", () => {
    expect(DEFAULT_RETRIEVE_CONFIG).toEqual({
      // balanced bundle
      entityLinkTopK: 8,
      candidateCap: 50,
      w_vec: 0.7,
      w_bm25: 0.15,
      neighborWidth: 1,
      // non-bundle base levers
      preset: "balanced",
      w_graph: 0.15,
      bm25Enabled: true,
      graphEnabled: true,
      rerankEnabled: false,
      graphArmFloor: 3,
    });
  });

  it("is exactly the default preset's bundle view", () => {
    expect(retrieveConfigForPreset("balanced")).toEqual(
      DEFAULT_RETRIEVE_CONFIG
    );
  });
});

describe("retrieveConfigForPreset (I1 SSOT)", () => {
  it("swaps only bundle-owned levers and keeps the base literal intact", () => {
    for (const preset of RETRIEVE_PRESETS) {
      expect(retrieveConfigForPreset(preset)).toEqual({
        ...RETRIEVE_PRESET_BUNDLES[preset],
        preset: "balanced",
        w_graph: 0.15,
        bm25Enabled: true,
        graphEnabled: true,
        rerankEnabled: false,
        graphArmFloor: 3,
      });
    }
  });

  it("is frozen against a caller mutation of the returned config", () => {
    // Each call must hand out a fresh object: concurrent retrieve calls
    // may never share a mutable ranking configuration.
    const a = retrieveConfigForPreset("tokenmax");
    const b = retrieveConfigForPreset("tokenmax");
    expect(a).not.toBe(b);
    a.candidateCap += 1;
    expect(b.candidateCap).toBe(100);
  });
});
