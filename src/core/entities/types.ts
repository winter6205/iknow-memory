/**
 * Domain types for the canonical entity merge bounded context.
 *
 * Resolved per P0 extraction plan T1: thresholds + chain depth locked here
 * (single source of truth for the merge gates). The merge module imports
 * these and nothing else from the extraction context (S1 bounded-context).
 */

export type GateLevel = "L0" | "L1" | "L2" | "L3";

export type MergeDecision =
  | { kind: "merge"; into: string; via: GateLevel; observedCosine: number }
  | {
      kind: "reject";
      reason: string;
      level: GateLevel;
      observedCosine?: number;
    };

/**
 * Tunable thresholds for the hierarchical merge gates.
 *
 * Defaults capture the P0c prototype verdict resolved in T1:
 *   - L2 description floor: 0.30
 *   - L3 single-floor high threshold: 0.50 (gray-zone = below)
 *   - L3 band low threshold: 0.30 (used only when bandMode = true)
 *   - min description length for L2: 8 chars
 *   - maxChainDepth: 16
 *   - bandMode: false (single-floor is the P0 default; band is the
 *     documented alternative gated by #15 Bootstrap data)
 */
export interface MergeConfig {
  l2DescLowThreshold: number;
  l3NameDescLowThreshold: number;
  l3NameDescHighThreshold: number;
  minDescriptionLength: number;
  maxChainDepth: number;
  bandMode: boolean;
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  l2DescLowThreshold: 0.3,
  l3NameDescLowThreshold: 0.3,
  l3NameDescHighThreshold: 0.5,
  minDescriptionLength: 8,
  maxChainDepth: 16,
  bandMode: false,
};

/**
 * Structured payload for gray-zone merge rejections (per #6 Q5).
 *
 * Emitted by the merge module via the project logger; consumers (T6 CLI,
 * T8 defensive tests) read these from stderr to audit merge outcomes.
 */
export interface GrayZoneLog {
  level: GateLevel;
  observedCosine?: number;
  reason: string;
}
