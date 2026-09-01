/**
 * PR drift gate + Release absolute gate (specs/p0-eval.md SC14, SC15).
 *
 * Three axes, one budget:
 *   - **driftGate** — SC14: PR runs cheap. `|ΔF1| ≤ 0.05` vs the last
 *     baseline passes; a wider swing fails. Missing baseline passes
 *     (nothing to drift against). PR ignores schema rate and
 *     hallucination rate drift: those axes are Release-grade, not
 *     PR-grade, and a PR-only run that pretends to score them would
 *     either need a gold LLM (forbidden on the PR path) or would
 *     over-fire on benign noise.
 *   - **releaseGate** — SC15: full three axes vs locked thresholds.
 *     Any axis that breaches its threshold fails the gate; the caller
 *     maps that to process exit 2. `f1` and `schemaRate` are
 *     lower-bound (≥), `hallucinationRate` is upper-bound (≤) — the
 *     natural direction for each metric.
 *   - **extractThresholds** — SC15: pulls the locked thresholds FROM
 *     the gold-set directory's `thresholds.json` file (refuse-until-
 *     lock). The Bootstrap period has no thresholds; the function
 *     returns `null` so the CLI can surface a clear ConfigError
 *     (SC12). The release thresholds live in `thresholds.json`, never
 *     as literals in this module.
 *
 * Per SC7, the five diagnostic error types are deliberately absent
 * from every gate signature: the suite pins the surface so a future
 * change cannot smuggle a `Map<string, ErrorType>` back in. Mis-
 * prediction diagnostics describe WHY a number moved; they do not
 * decide whether the gate trips.
 *
 * Pure: no I/O, no clock, no randomness, no LLM. The CLI layer
 * (E-T6) reads the baseline file via `baseline.ts` and the
 * thresholds file, and hands the parsed data to these functions.
 */

import type { LockedThresholds } from "./baseline.js";

/**
 * The three numeric axes the gate consumes. Same shape on both the
 * current run and the baseline entry — comparing two of these is the
 * drift gate's entire job.
 */
export interface Axes {
  f1: number;
  schemaRate: number;
  hallucinationRate: number;
}

/**
 * Locked release thresholds. F1 and schema rate are lower-bound
 * ("must be at least"); hallucination rate is upper-bound ("must be
 * at most"). The direction lives on the call site (releaseGate) so a
 * future axis can adopt either semantics without a key rename.
 *
 * Re-exported as the gate-facing alias of `LockedThresholds` (the
 * baseline module owns the canonical name; the gate keeps a friendly
 * alias for callers that import from this module).
 */
export type ReleaseThresholds = LockedThresholds;

/**
 * Pull the locked thresholds FROM the gold-set directory. Returns
 * `null` when no `thresholds.json` exists — the Bootstrap period
 * records axes only and a release run against that state is a
 * misconfiguration the CLI (E-T6) surfaces as a ConfigError (SC12).
 *
 * Returns a shallow copy so a caller mutating the result cannot
 * silently rewrite the threshold file.
 */
export function extractThresholds(
  locked: LockedThresholds | null
): ReleaseThresholds | null {
  if (locked === null) return null;
  return { ...locked };
}

/** Knobs for driftGate. */
export interface DriftOpts {
  /**
   * Inclusive bound on `|ΔF1|`. SC14 fixes this at 0.05; the gate
   * accepts it as an opt rather than a literal so the value lives
   * with the CLI config and is trivially overridable in tests.
   */
  driftTolerance: number;
}

/**
 * Drift outcome.
 *   - `{ pass: true, missing: true }`        — no baseline; pass.
 *   - `{ pass: true, delta }`                — drift within bounds.
 *   - `{ pass: false, delta }`               — F1 drift > tolerance.
 */
export interface DriftResult {
  pass: boolean;
  missing?: true;
  delta?: Axes;
}

/** Per-axis failure flags. An axis absent from this object passed. */
export interface ReleaseFailures {
  f1?: true;
  schemaRate?: true;
  hallucinationRate?: true;
}

/** Release outcome. */
export interface ReleaseResult {
  pass: boolean;
  failures: ReleaseFailures;
}

/**
 * PR drift gate. Returns `{pass: true, missing: true}` when there is
 * no baseline to compare against (SC14: "missing baseline → pass").
 *
 * Otherwise computes the signed F1 delta against the baseline; the
 * verdict uses `|ΔF1|` so an improvement and a regression have the
 * same budget. Schema rate and hallucination rate deltas are
 * reported for the operator's reading but never enter the verdict
 * (per SC14, only F1 gates the PR path).
 */
export function driftGate(
  currentAxes: Axes,
  baselineAxes: Axes | null,
  opts: DriftOpts
): DriftResult {
  if (baselineAxes === null) {
    return { pass: true, missing: true };
  }
  const delta: Axes = {
    f1: currentAxes.f1 - baselineAxes.f1,
    schemaRate: currentAxes.schemaRate - baselineAxes.schemaRate,
    hallucinationRate:
      currentAxes.hallucinationRate - baselineAxes.hallucinationRate,
  };
  const pass = Math.abs(delta.f1) <= opts.driftTolerance;
  return { pass, delta };
}

/**
 * Release absolute gate. Every axis is checked against its threshold
 * in `extractThresholds`-style input:
 *   - `f1 >= thresholds.f1Minimum`
 *   - `schemaRate >= thresholds.schemaRateMinimum`
 *   - `hallucinationRate <= thresholds.hallucinationRateMaximum`
 *
 * Axes that breach are listed under `failures` (the value is `true`;
 * presence is the signal). An empty `failures` object means pass.
 *
 * The function intentionally has no `errors` / diagnostic parameter:
 * SC7 forbids it, and the test suite pins the surface so a future
 * change cannot reintroduce one.
 */
export function releaseGate(
  currentAxes: Axes,
  thresholds: ReleaseThresholds
): ReleaseResult {
  const failures: ReleaseFailures = {};
  if (currentAxes.f1 < thresholds.f1Minimum) failures.f1 = true;
  if (currentAxes.schemaRate < thresholds.schemaRateMinimum)
    failures.schemaRate = true;
  if (currentAxes.hallucinationRate > thresholds.hallucinationRateMaximum) {
    failures.hallucinationRate = true;
  }
  return { pass: Object.keys(failures).length === 0, failures };
}
