/**
 * Ablation matrix: configuration builder, pure aggregation, deterministic
 * report renderer (specs/es-precision-layer.md SC-7, §B4 capability keys).
 *
 * The matrix has 8 independent capability toggles named verbatim in
 * `specs/retrieval-stack.md` §B4 — both repos agree on the spelling — and
 * 10 configurations: 1 all-on baseline, 8 single-off ablations (one per
 * capability), 1 all-off floor. The matrix builder, the median / percentage
 * helpers and the schema below are pure functions so the SC-7 contract is
 * testable without standing up an embedder, an ES sidecar or a Neo4j
 * adapter. The CLI (`src/cli/eval-stack.ts`) is the only layer that
 * touches the retrieval orchestrator, and only because the runner port
 * needs SOMETHING to produce the raw samples.
 *
 * The renderer is deliberately deterministic — same input twice yields
 * byte-identical output. Field order in the JSON object literal is the
 * stable contract; downstream tools git-diff the report and depend on
 * diffs being explainable rather than reflective of input order.
 */
import { AblationMatrixError } from "./errors.js";

/**
 * Capability toggles, exactly the eight named in §B4.
 *
 * Spelled in the same order both repos agree on (vector → rerank), so a
 * human reading the JSON report and the spec table lines up line for
 * line. The `ALL_ON` matrix entry uses the same ordering.
 */
export const ABLATION_CAPABILITY_KEYS = [
  "vector",
  "keyword_bm25",
  "cjk_segmentation",
  "phrase",
  "field_boost",
  "graph_ppr",
  "rrf",
  "rerank",
] as const;

export type AblationCapability = (typeof ABLATION_CAPABILITY_KEYS)[number];

/** Which capabilities are switched on for a single configuration. */
export type AblationCapabilities = Readonly<
  Record<AblationCapability, boolean>
>;

/** One matrix row — a name, a single capability removed (or not), and the toggle set. */
export interface AblationConfig {
  /** Stable label used in JSON and Markdown. */
  id: string;
  /** Human description for the Markdown table. */
  description: string;
  /** Capabilities kept on for this row. */
  capabilities: AblationCapabilities;
  /** The one capability this row removed, or null for the all-on / all-off rows. */
  offCapability: AblationCapability | null;
}

/** Raw metric sample from one (config, repeat) invocation. */
export interface AblationMetricSample {
  /** mean P@5 across the gold queries. */
  meanPAt5: number;
  /** mean R@5 across the gold queries. */
  meanRAt5: number;
}

/** Aggregated row over the N repeats of one configuration. */
export interface AblationConfigResult {
  config: AblationConfig;
  /** N raw samples; the runner owns the N. */
  rawRuns: AblationMetricSample[];
  /** median of `rawRuns` P@5 / R@5 (N samples, sorted). */
  median: AblationMetricSample;
  /** (value − baseline) / baseline × 100, rounded to two decimals. */
  percentageChange: AblationMetricSample;
}

/** Full ablation report. The `configCount` field guards "missing config = 0". */
export interface AblationReport {
  schema: "iknow-retrieve-ablation/v1";
  /** The fixed eight capability keys, in the canonical order. */
  capabilityKeys: readonly AblationCapability[];
  /** All-on baseline id used for percentage change. */
  baselineConfigId: string;
  /** Per-config aggregated result. */
  configs: AblationConfigResult[];
  /** Number of configurations in the matrix; equals `configs.length`. */
  configCount: number;
  /** Number of raw runs per configuration; the runner owns it. */
  runsPerConfig: number;
}

/** Wire shape of one raw sample after the runner has produced it. */
export interface RawSampleInput {
  meanPAt5: number;
  meanRAt5: number;
}

/* -------------------------------------------------------------------------- */
/* Matrix builder                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the 10-configuration ablation matrix: 1 all-on, 8 single-off,
 * 1 all-off. The order matters because both the Markdown renderer and the
 * SC-7 contract name them in this sequence.
 *
 * - All-on baseline first.
 * - Eight single-off rows: one per capability key, each with that key off.
 * - All-off floor last.
 */
export function buildAblationConfigs(): readonly AblationConfig[] {
  const allOn: AblationCapabilities = {
    vector: true,
    keyword_bm25: true,
    cjk_segmentation: true,
    phrase: true,
    field_boost: true,
    graph_ppr: true,
    rrf: true,
    rerank: true,
  };
  const configs: AblationConfig[] = [
    {
      id: "all-on",
      description: "all capabilities on",
      capabilities: allOn,
      offCapability: null,
    },
  ];
  for (const key of ABLATION_CAPABILITY_KEYS) {
    const capabilities: AblationCapabilities = { ...allOn, [key]: false };
    configs.push({
      id: `off-${key}`,
      description: `all capabilities on except ${key}`,
      capabilities,
      offCapability: key,
    });
  }
  const allOff: AblationCapabilities = {
    vector: false,
    keyword_bm25: false,
    cjk_segmentation: false,
    phrase: false,
    field_boost: false,
    graph_ppr: false,
    rrf: false,
    rerank: false,
  };
  configs.push({
    id: "all-off",
    description: "all capabilities off",
    capabilities: allOff,
    offCapability: null,
  });
  return configs;
}

/**
 * Lookup helper used by the CLI to identify the baseline row when
 * computing percentage change. Refuses an empty matrix so a renderer
 * can never publish a "0% change" line that papers over a missing
 * baseline.
 */
export function findBaselineConfig(
  configs: readonly AblationConfig[]
): AblationConfig {
  const baseline = configs.find((c) => c.id === "all-on");
  if (baseline === undefined) {
    throw new AblationMatrixError(
      "ablation matrix has no all-on baseline row: cannot compute percentage change without a reference"
    );
  }
  return baseline;
}

/* -------------------------------------------------------------------------- */
/* Pure aggregation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Median of a non-empty numeric sample.
 *
 * An empty input is a typed error rather than `NaN`: a report that
 * publishes `0% change` for an empty sample would be indistinguishable
 * from a real "no movement" row, and downstream diffs would read it as a
 * retrieval regression or improvement for a run that never happened.
 *
 * `NaN` is rejected for the same reason: `NaN` poisons every downstream
 * aggregate that includes it, and `median([NaN, 0.5])` reading as
 * `0.25` is the exact silent failure SC-7 forbids.
 */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new AblationMatrixError(
      "cannot compute median of an empty sample set: every (config, repeat) slot must produce a number"
    );
  }
  for (const value of samples) {
    if (!Number.isFinite(value)) {
      throw new AblationMatrixError(
        `ablation median input is not finite: ${String(value)}`
      );
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) {
    throw new AblationMatrixError(
      "ablation median input is missing entries after sorting: this is a programming error, not a fixture bug"
    );
  }
  return (lower + upper) / 2;
}

/**
 * Percentage change relative to a baseline.
 *
 * `value === baseline` → `0`. `value > baseline` → positive. `value < baseline`
 * → negative. Rounded to two decimal places so a downstream Markdown
 * column lines up.
 *
 * A baseline of zero is a typed error: reporting `(1 − 0) / 0 × 100 = ∞`
 * would publish `Infinity` to the JSON report and `NaN%` to the Markdown
 * column. The matrix guards this here so neither renderer has to.
 */
export function percentageChange(value: number, baseline: number): number {
  if (!Number.isFinite(value)) {
    throw new AblationMatrixError(
      `percentage change: value is not finite: ${String(value)}`
    );
  }
  if (!Number.isFinite(baseline)) {
    throw new AblationMatrixError(
      `percentage change: baseline is not finite: ${String(baseline)}`
    );
  }
  if (baseline === 0) {
    throw new AblationMatrixError(
      "percentage change: baseline is zero — a zero baseline would produce Infinity or NaN, the report must not publish either"
    );
  }
  return round2(((value - baseline) / baseline) * 100);
}

/**
 * Round to two decimal places using banker's-rounding semantics so a fixed
 * input yields a fixed output: the JSON renderer is byte-stable across
 * runs only if this is deterministic.
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Per-config aggregation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Aggregate one configuration's raw samples into a result row.
 *
 * `baselineSample` is the median P@5 / R@5 of the all-on baseline row,
 * pre-computed by the caller so all rows are scored against the same
 * reference. The function is pure: given the same inputs it produces
 * the same output, so a second run with the same samples is byte-stable.
 *
 * `isBaseline` short-circuits the percentage change step for the
 * all-on row: the row is its own reference and the percentage change
 * is zero by construction. Without the short-circuit, a baseline
 * median of 0 (an empty / non-hitting fixture) would trip the
 * `percentageChange` zero-baseline guard and refuse to publish the
 * row, which is the silent failure SC-7 forbids.
 */
export function aggregateConfig(
  config: AblationConfig,
  rawRuns: readonly RawSampleInput[],
  baselineSample: AblationMetricSample,
  isBaseline: boolean
): AblationConfigResult {
  if (rawRuns.length === 0) {
    throw new AblationMatrixError(
      `ablation row "${config.id}" has zero raw runs: every configuration must record at least one raw sample`
    );
  }
  const meanPAt5 = median(rawRuns.map((s) => s.meanPAt5));
  const meanRAt5 = median(rawRuns.map((s) => s.meanRAt5));
  const medianSample: AblationMetricSample = { meanPAt5, meanRAt5 };
  return {
    config,
    rawRuns: rawRuns.map((s) => ({ ...s })),
    median: medianSample,
    percentageChange: isBaseline
      ? { meanPAt5: 0, meanRAt5: 0 }
      : {
          meanPAt5: percentageChange(meanPAt5, baselineSample.meanPAt5),
          meanRAt5: percentageChange(meanRAt5, baselineSample.meanRAt5),
        },
  };
}

/**
 * Build the full ablation report from raw samples.
 *
 * The caller hands in one raw sample per (config, repeat); the function
 * owns the per-config aggregation and the percentage-vs-all-on step. The
 * baseline row's own percentage change is `0` by construction — anything
 * else would be a self-referential error.
 */
export function buildAblationReport(input: {
  configs: readonly AblationConfig[];
  samples: ReadonlyMap<string, readonly RawSampleInput[]>;
  runsPerConfig: number;
}): AblationReport {
  const baseline = findBaselineConfig(input.configs);
  const baselineSamples = input.samples.get(baseline.id);
  if (baselineSamples === undefined || baselineSamples.length === 0) {
    throw new AblationMatrixError(
      `ablation matrix is missing raw samples for the all-on baseline ("${baseline.id}"); a report without a baseline cannot express percentage change`
    );
  }
  const baselineMedian: AblationMetricSample = {
    meanPAt5: median(baselineSamples.map((s) => s.meanPAt5)),
    meanRAt5: median(baselineSamples.map((s) => s.meanRAt5)),
  };

  const configs: AblationConfigResult[] = input.configs.map((config) => {
    const samples = input.samples.get(config.id);
    if (samples === undefined) {
      throw new AblationMatrixError(
        `ablation matrix is missing raw samples for "${config.id}": SC-7 forbids missing configurations`
      );
    }
    return aggregateConfig(
      config,
      samples,
      baselineMedian,
      config.id === baseline.id
    );
  });

  // Zero the baseline's own percentage change after the fact so the
  // helper above stays composable across every row.
  const baselineRow = configs.find((row) => row.config.id === baseline.id);
  if (baselineRow !== undefined) {
    configs[configs.indexOf(baselineRow)] = {
      ...baselineRow,
      percentageChange: { meanPAt5: 0, meanRAt5: 0 },
    };
  }

  return {
    schema: "iknow-retrieve-ablation/v1",
    capabilityKeys: ABLATION_CAPABILITY_KEYS,
    baselineConfigId: baseline.id,
    configs,
    configCount: configs.length,
    runsPerConfig: input.runsPerConfig,
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic report renderers                                              */
/* -------------------------------------------------------------------------- */

/**
 * Render the report to deterministic JSON bytes.
 *
 * The output is the exact bytes that go on disk. Field order comes from
 * the object literal below, not from the input object, so a caller that
 * builds the report in a different order still produces an identical
 * file. Per-row samples are projected into a stable shape before being
 * stringified, because `Map` insertion order is implementation-defined.
 */
export function renderAblationJson(report: AblationReport): string {
  const ordered = {
    schema: report.schema,
    capabilityKeys: [...report.capabilityKeys],
    baselineConfigId: report.baselineConfigId,
    configCount: report.configCount,
    runsPerConfig: report.runsPerConfig,
    configs: report.configs.map((row) => ({
      id: row.config.id,
      description: row.config.description,
      offCapability: row.config.offCapability,
      capabilities: { ...row.config.capabilities },
      rawRuns: row.rawRuns.map((s) => ({
        meanPAt5: round2(s.meanPAt5),
        meanRAt5: round2(s.meanRAt5),
      })),
      median: {
        meanPAt5: round2(row.median.meanPAt5),
        meanRAt5: round2(row.median.meanRAt5),
      },
      percentageChange: {
        meanPAt5: round2(row.percentageChange.meanPAt5),
        meanRAt5: round2(row.percentageChange.meanRAt5),
      },
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Render the report to deterministic Markdown bytes.
 *
 * One table per configuration. The all-on row goes first because it is
 * the baseline; the all-off row goes last because it is the floor. The
 * table columns are spelled in the order a human reads them: id,
 * description, median P@5, median R@5, then the change columns. A single
 * fixed width keeps the diff readable.
 */
export function renderAblationMarkdown(report: AblationReport): string {
  const lines: string[] = [];
  lines.push("# Retrieve ablation matrix");
  lines.push("");
  lines.push(`- schema: \`${report.schema}\``);
  lines.push(`- baseline: \`${report.baselineConfigId}\``);
  lines.push(`- configurations: ${report.configCount}`);
  lines.push(`- runs per configuration: ${report.runsPerConfig}`);
  lines.push(
    `- capabilities: ${report.capabilityKeys.map((k) => `\`${k}\``).join(", ")}`
  );
  lines.push("");
  lines.push(
    "| id | off | median P@5 | Δ P@5 (%) | median R@5 | Δ R@5 (%) | description |"
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const row of report.configs) {
    lines.push(
      `| ${[
        `\`${row.config.id}\``,
        row.config.offCapability === null
          ? "—"
          : `\`${row.config.offCapability}\``,
        round2(row.median.meanPAt5).toFixed(2),
        `${round2(row.percentageChange.meanPAt5).toFixed(2)}%`,
        round2(row.median.meanRAt5).toFixed(2),
        `${round2(row.percentageChange.meanRAt5).toFixed(2)}%`,
        row.config.description,
      ].join(" | ")} |`
    );
  }
  lines.push("");
  lines.push("## Raw runs");
  lines.push("");
  for (const row of report.configs) {
    lines.push(`### \`${row.config.id}\``);
    lines.push("");
    lines.push("| run | P@5 | R@5 |");
    lines.push("| --- | ---: | ---: |");
    row.rawRuns.forEach((sample, i) => {
      lines.push(
        `| ${i + 1} | ${round2(sample.meanPAt5).toFixed(2)} | ${round2(sample.meanRAt5).toFixed(2)} |`
      );
    });
    lines.push("");
  }
  return lines.join("\n");
}
