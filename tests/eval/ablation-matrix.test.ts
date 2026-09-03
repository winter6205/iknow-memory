/**
 * Ablation matrix pure functions (specs/es-precision-layer.md SC-7).
 *
 * Everything here is single-process arithmetic and object construction:
 * no embedder, no storage, no network. The matrix builder, the median
 * / percentage helpers and the deterministic renderer are the contract
 * that downstream git-tracked reports diff against, so the assertions
 * below prove (a) the matrix has exactly 10 rows in the right order,
 * (b) the aggregator refuses degenerate inputs, and (c) the renderer
 * is byte-stable.
 */
import { describe, it, expect } from "vitest";

import {
  ABLATION_CAPABILITY_KEYS,
  aggregateConfig,
  buildAblationConfigs,
  buildAblationReport,
  findBaselineConfig,
  median,
  percentageChange,
  renderAblationJson,
  renderAblationMarkdown,
  round2,
  type AblationCapabilities,
  type AblationConfig,
  type RawSampleInput,
} from "../../src/core/eval/ablation-matrix.js";
import { AblationMatrixError } from "../../src/core/eval/errors.js";

const ALL_ON: AblationCapabilities = {
  vector: true,
  keyword_bm25: true,
  cjk_segmentation: true,
  phrase: true,
  field_boost: true,
  graph_ppr: true,
  rrf: true,
  rerank: true,
};

describe("ABLATION_CAPABILITY_KEYS", () => {
  it("lists the eight §B4 keys in the agreed order", () => {
    expect(ABLATION_CAPABILITY_KEYS).toEqual([
      "vector",
      "keyword_bm25",
      "cjk_segmentation",
      "phrase",
      "field_boost",
      "graph_ppr",
      "rrf",
      "rerank",
    ]);
  });

  it("covers exactly the eight keys, no duplicates", () => {
    expect(new Set(ABLATION_CAPABILITY_KEYS).size).toBe(8);
    expect(ABLATION_CAPABILITY_KEYS).toHaveLength(8);
  });
});

describe("buildAblationConfigs", () => {
  it("produces 10 configurations: 1 all-on, 8 single-off, 1 all-off", () => {
    const configs = buildAblationConfigs();
    expect(configs).toHaveLength(10);
  });

  it("opens with the all-on baseline", () => {
    const first = buildAblationConfigs()[0]!;
    expect(first.id).toBe("all-on");
    expect(first.offCapability).toBeNull();
    expect(first.capabilities).toEqual(ALL_ON);
  });

  it("closes with the all-off floor", () => {
    const last = buildAblationConfigs()[buildAblationConfigs().length - 1]!;
    expect(last.id).toBe("all-off");
    expect(last.offCapability).toBeNull();
    for (const key of ABLATION_CAPABILITY_KEYS) {
      expect(last.capabilities[key]).toBe(false);
    }
  });

  it("single-off rows cover every §B4 capability exactly once", () => {
    const configs = buildAblationConfigs();
    const singleOff = configs.slice(1, configs.length - 1);
    expect(singleOff).toHaveLength(8);
    const offCapabilities = singleOff.map((c) => c.offCapability);
    expect(offCapabilities).toEqual([...ABLATION_CAPABILITY_KEYS]);
  });

  it("each single-off row disables exactly the named capability", () => {
    const configs = buildAblationConfigs();
    for (const config of configs) {
      if (config.offCapability === null) continue;
      expect(config.capabilities[config.offCapability]).toBe(false);
      for (const key of ABLATION_CAPABILITY_KEYS) {
        if (key === config.offCapability) continue;
        expect(config.capabilities[key]).toBe(true);
      }
    }
  });
});

describe("findBaselineConfig", () => {
  it("returns the all-on row", () => {
    const baseline = findBaselineConfig(buildAblationConfigs());
    expect(baseline.id).toBe("all-on");
  });

  it("throws when the matrix has no all-on baseline", () => {
    expect(() => findBaselineConfig([])).toThrowError(AblationMatrixError);
  });
});

describe("median", () => {
  it("returns the middle value of an odd-length sorted sample", () => {
    expect(median([0.1, 0.5, 0.9])).toBeCloseTo(0.5, 12);
  });

  it("averages the two middle values of an even-length sorted sample", () => {
    expect(median([0.1, 0.3, 0.7, 0.9])).toBeCloseTo(0.5, 12);
  });

  it("does not mutate the input array", () => {
    const input = [0.3, 0.1, 0.5];
    median(input);
    expect(input).toEqual([0.3, 0.1, 0.5]);
  });

  it("refuses an empty sample set instead of returning NaN", () => {
    expect(() => median([])).toThrowError(AblationMatrixError);
  });

  it("refuses a non-finite sample instead of poisoning the result", () => {
    expect(() => median([0.5, Number.NaN, 0.9])).toThrowError(
      AblationMatrixError
    );
  });
});

describe("percentageChange", () => {
  it("returns zero when value equals baseline", () => {
    expect(percentageChange(0.4, 0.4)).toBe(0);
  });

  it("returns positive for value > baseline", () => {
    expect(percentageChange(0.6, 0.5)).toBe(20);
  });

  it("returns negative for value < baseline", () => {
    expect(percentageChange(0.4, 0.5)).toBe(-20);
  });

  it("rounds to two decimals so report diffs are stable", () => {
    expect(percentageChange(0.33333, 0.5)).toBe(-33.33);
  });

  it("refuses a zero baseline rather than publishing Infinity", () => {
    expect(() => percentageChange(0.5, 0)).toThrowError(AblationMatrixError);
  });

  it("refuses a non-finite value", () => {
    expect(() => percentageChange(Number.POSITIVE_INFINITY, 0.5)).toThrowError(
      AblationMatrixError
    );
  });
});

describe("round2", () => {
  it("rounds to two decimals", () => {
    expect(round2(0.345)).toBe(0.35);
    expect(round2(-0.345)).toBe(-0.34);
  });
});

describe("aggregateConfig", () => {
  const baseline = { meanPAt5: 0.5, meanRAt5: 0.5 };
  const config: AblationConfig = {
    id: "all-on",
    description: "all capabilities on",
    capabilities: ALL_ON,
    offCapability: null,
  };

  it("publishes the median of every raw run", () => {
    const raw: RawSampleInput[] = [
      { meanPAt5: 0.4, meanRAt5: 0.6 },
      { meanPAt5: 0.5, meanRAt5: 0.5 },
      { meanPAt5: 0.6, meanRAt5: 0.4 },
    ];
    const result = aggregateConfig(config, raw, baseline, false);
    expect(result.median).toEqual({ meanPAt5: 0.5, meanRAt5: 0.5 });
    expect(result.rawRuns).toEqual(raw);
  });

  it("publishes percentage change relative to the baseline", () => {
    const raw: RawSampleInput[] = [{ meanPAt5: 0.4, meanRAt5: 0.6 }];
    const result = aggregateConfig(config, raw, baseline, false);
    expect(result.percentageChange.meanPAt5).toBe(-20);
    expect(result.percentageChange.meanRAt5).toBe(20);
  });

  it("zeros the percentage change for the baseline row itself", () => {
    const raw: RawSampleInput[] = [{ meanPAt5: 0, meanRAt5: 0 }];
    const result = aggregateConfig(config, raw, baseline, true);
    expect(result.percentageChange).toEqual({ meanPAt5: 0, meanRAt5: 0 });
  });

  it("refuses an empty raw sample set", () => {
    expect(() => aggregateConfig(config, [], baseline, false)).toThrowError(
      AblationMatrixError
    );
  });
});

describe("buildAblationReport", () => {
  const configs = buildAblationConfigs();
  const makeSamples = (pAt5: number, rAt5: number): RawSampleInput[] =>
    Array.from({ length: 3 }, () => ({ meanPAt5: pAt5, meanRAt5: rAt5 }));

  it("produces a report with the schema tag, capability keys, and counts", () => {
    const samples = new Map<string, RawSampleInput[]>();
    for (const c of configs) samples.set(c.id, makeSamples(0.5, 0.5));
    const report = buildAblationReport({
      configs,
      samples,
      runsPerConfig: 3,
    });
    expect(report.schema).toBe("iknow-retrieve-ablation/v1");
    expect(report.capabilityKeys).toEqual(ABLATION_CAPABILITY_KEYS);
    expect(report.configCount).toBe(10);
    expect(report.runsPerConfig).toBe(3);
    expect(report.baselineConfigId).toBe("all-on");
    expect(report.configs).toHaveLength(10);
  });

  it("zeros the all-on baseline's own percentage change", () => {
    const samples = new Map<string, RawSampleInput[]>();
    for (const c of configs) samples.set(c.id, makeSamples(0.5, 0.5));
    const report = buildAblationReport({
      configs,
      samples,
      runsPerConfig: 3,
    });
    const baselineRow = report.configs.find((r) => r.config.id === "all-on");
    expect(baselineRow?.percentageChange).toEqual({ meanPAt5: 0, meanRAt5: 0 });
  });

  it("rejects a matrix missing the all-on baseline samples", () => {
    const samples = new Map<string, RawSampleInput[]>();
    samples.set("off-vector", makeSamples(0.5, 0.5));
    expect(() =>
      buildAblationReport({ configs, samples, runsPerConfig: 1 })
    ).toThrowError(AblationMatrixError);
  });

  it("rejects a matrix missing a single-off row", () => {
    const samples = new Map<string, RawSampleInput[]>();
    samples.set("all-on", makeSamples(0.5, 0.5));
    expect(() =>
      buildAblationReport({ configs, samples, runsPerConfig: 1 })
    ).toThrowError(AblationMatrixError);
  });
});

describe("renderAblationJson — deterministic", () => {
  const configs = buildAblationConfigs();
  const samples = new Map<string, RawSampleInput[]>();
  for (const c of configs) {
    samples.set(
      c.id,
      Array.from({ length: 3 }, () => ({ meanPAt5: 0.5, meanRAt5: 0.5 }))
    );
  }

  it("renders byte-identical output for the same input twice", () => {
    const report = buildAblationReport({
      configs,
      samples,
      runsPerConfig: 3,
    });
    const first = renderAblationJson(report);
    const second = renderAblationJson(report);
    expect(second).toBe(first);
  });

  it("carries the SC-7 schema tag in the payload", () => {
    const report = buildAblationReport({
      configs,
      samples,
      runsPerConfig: 3,
    });
    const payload = JSON.parse(renderAblationJson(report)) as {
      schema: string;
    };
    expect(payload.schema).toBe("iknow-retrieve-ablation/v1");
  });
});

describe("renderAblationMarkdown — deterministic", () => {
  const configs = buildAblationConfigs();
  const samples = new Map<string, RawSampleInput[]>();
  for (const c of configs) {
    samples.set(
      c.id,
      Array.from({ length: 3 }, () => ({ meanPAt5: 0.5, meanRAt5: 0.5 }))
    );
  }

  it("renders byte-identical output for the same input twice", () => {
    const report = buildAblationReport({
      configs,
      samples,
      runsPerConfig: 3,
    });
    const first = renderAblationMarkdown(report);
    const second = renderAblationMarkdown(report);
    expect(second).toBe(first);
  });

  it("opens with a header and includes every configuration row", () => {
    const report = buildAblationReport({
      configs,
      samples,
      runsPerConfig: 3,
    });
    const md = renderAblationMarkdown(report);
    expect(md).toMatch(/Retrieve ablation matrix/);
    for (const c of configs) {
      expect(md).toContain(`\`${c.id}\``);
    }
  });
});
