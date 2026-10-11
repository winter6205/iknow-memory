import { KEY_REGISTRY, isKnownKey, type KeySpec } from "./key-registry.js";
import {
  resolveLayeredValue,
  type EnvBag,
  type LayerSources,
} from "./layered-value.js";

export interface EffectiveKeyReport {
  key: string;
  value: string;
  layer: "env" | "setting" | "home-env-file" | "default";
  effect: "restart" | "rotate" | "next-extraction";
}

export interface RecordedEmbedGeneration {
  model: string | null;
  dimensions: number;
}

export interface EffectiveConfigInput {
  env: EnvBag;
  setting: Readonly<Record<string, string>>;
  homeEnv: Readonly<Record<string, string>>;
  cwdEnvLocalPresent: boolean;
  sourceExtractionFingerprints?: readonly (string | null)[];
  recordedGeneration?: RecordedEmbedGeneration | null;
  processReportLines?: readonly string[];
  gaps?: readonly string[];
}

export interface ExtractionFingerprintGroup {
  fingerprint: string | null;
  count: number;
}

export interface EffectiveConfigReport {
  keys: readonly EffectiveKeyReport[];
  shadowedSettingKeys: readonly string[];
  unknownKeys: readonly string[];
  cwdEnvLocalPresent: boolean;
  extractionFingerprintSummary?: "mixed" | "uniform" | "empty";
  extractionFingerprintGroups?: readonly ExtractionFingerprintGroup[];
  embedGenerationMismatches: readonly string[];
  processReportLines: readonly string[];
  gaps: readonly string[];
}

function sourcesOf(input: EffectiveConfigInput): LayerSources {
  return { env: input.env, setting: input.setting, homeEnv: input.homeEnv };
}

function reportKey(spec: KeySpec, sources: LayerSources): EffectiveKeyReport {
  const resolved = resolveLayeredValue(spec.env, sources);
  if (spec.secret) {
    return {
      key: spec.env,
      value: resolved.value === undefined ? "unset" : "configured",
      layer: resolved.layer,
      effect: spec.effect,
    };
  }
  if (resolved.value !== undefined) {
    return {
      key: spec.env,
      value: displayedValue(spec.env, resolved.value),
      layer: resolved.layer,
      effect: spec.effect,
    };
  }
  return {
    key: spec.env,
    value: spec.defaultValue ?? "unset",
    layer: "default",
    effect: spec.effect,
  };
}

function nonBlankOwn(bag: EnvBag, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(bag, key)) return false;
  const raw = bag[key];
  return raw !== undefined && raw.trim() !== "";
}

function shadowedSettingKeys(
  env: EnvBag,
  setting: Readonly<Record<string, string>>
): string[] {
  const names: string[] = [];
  for (const key of Object.keys(setting).sort()) {
    if (nonBlankOwn(setting, key) && nonBlankOwn(env, key)) names.push(key);
  }
  return names;
}

function unknownGraphragKeys(
  env: EnvBag,
  setting: Readonly<Record<string, string>>
): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GRAPHRAG_MEMORY_") &&
      !isKnownKey(key) &&
      nonBlankOwn(env, key)
    ) {
      names.add(key);
    }
  }
  for (const key of Object.keys(setting)) {
    if (
      key.startsWith("GRAPHRAG_MEMORY_") &&
      !isKnownKey(key) &&
      nonBlankOwn(setting, key)
    ) {
      names.add(key);
    }
  }
  return [...names].sort();
}

function groupKey(value: string | null): string | null {
  if (value === null || value === "") return null;
  return value;
}

function compareFingerprintGroups(
  a: ExtractionFingerprintGroup,
  b: ExtractionFingerprintGroup
): number {
  if (a.fingerprint === b.fingerprint) return 0;
  if (a.fingerprint === null) return 1;
  if (b.fingerprint === null) return -1;
  return a.fingerprint.localeCompare(b.fingerprint);
}

function extractionFingerprintGroups(
  values: readonly (string | null)[] | undefined
): readonly ExtractionFingerprintGroup[] | undefined {
  if (values === undefined) return undefined;
  const counts = new Map<string | null, number>();
  for (const value of values) {
    const key = groupKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .sort(compareFingerprintGroups);
}

function extractionFingerprintSummary(
  groups: readonly ExtractionFingerprintGroup[] | undefined
): EffectiveConfigReport["extractionFingerprintSummary"] {
  if (groups === undefined) return undefined;
  let nonEmpty = 0;
  for (const group of groups) {
    if (group.fingerprint !== null) nonEmpty += 1;
  }
  if (nonEmpty >= 2) return "mixed";
  if (nonEmpty === 1) return "uniform";
  return "empty";
}

export function redactDatabaseUrlUserinfo(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return value;
  }
  if (parsed.username === "" && parsed.password === "") return value;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function displayedValue(key: string, value: string): string {
  if (key === "GRAPHRAG_MEMORY_DB_URL") return redactDatabaseUrlUserinfo(value);
  return value;
}

function embedGenerationMismatches(
  keys: readonly EffectiveKeyReport[],
  recorded: RecordedEmbedGeneration | null | undefined
): string[] {
  if (recorded === undefined || recorded === null) return [];
  const model = keys.find(
    (row) => row.key === "GRAPHRAG_MEMORY_EMBED_MODEL"
  )?.value;
  const dimensions = keys.find(
    (row) => row.key === "GRAPHRAG_MEMORY_EMBED_DIMENSIONS"
  )?.value;
  const mismatches: string[] = [];
  if ((recorded.model ?? "unset") !== model) mismatches.push("model");
  if (String(recorded.dimensions) !== dimensions) mismatches.push("dimensions");
  return mismatches;
}

export function describeEffectiveConfig(
  input: EffectiveConfigInput
): EffectiveConfigReport {
  const sources = sourcesOf(input);
  const keys = KEY_REGISTRY.map((spec) => reportKey(spec, sources)).sort(
    (a, b) => a.key.localeCompare(b.key)
  );
  const extractionGroups = extractionFingerprintGroups(
    input.sourceExtractionFingerprints
  );
  return {
    keys,
    shadowedSettingKeys: shadowedSettingKeys(input.env, input.setting),
    unknownKeys: unknownGraphragKeys(input.env, input.setting),
    cwdEnvLocalPresent: input.cwdEnvLocalPresent,
    extractionFingerprintSummary:
      extractionFingerprintSummary(extractionGroups),
    extractionFingerprintGroups: extractionGroups,
    embedGenerationMismatches: embedGenerationMismatches(
      keys,
      input.recordedGeneration
    ),
    processReportLines: input.processReportLines ?? [],
    gaps: input.gaps ?? [],
  };
}

function formatKeyLine(entry: EffectiveKeyReport): string {
  return `${entry.key}=${entry.value} layer=${entry.layer} effect=${entry.effect}`;
}

function formatExtractionFingerprints(
  report: EffectiveConfigReport
): string | undefined {
  const groups = report.extractionFingerprintGroups;
  if (groups === undefined || groups.length === 0) return undefined;
  const counts = groups
    .map((group) => `${group.fingerprint ?? "empty"}=${group.count}`)
    .join(" ");
  if (report.extractionFingerprintSummary === "mixed") {
    return `extraction fingerprints: mixed ${counts}`;
  }
  return `extraction fingerprints: ${counts}`;
}

export function formatEffectiveConfig(report: EffectiveConfigReport): string {
  const lines = report.keys.map(formatKeyLine);
  for (const key of report.shadowedSettingKeys) {
    lines.push(`shadowed setting: ${key}`);
  }
  for (const key of report.unknownKeys) {
    lines.push(`unknown: ${key}`);
  }
  if (report.cwdEnvLocalPresent) {
    lines.push("cwd .env.local: not in effect");
  }
  const extractionLine = formatExtractionFingerprints(report);
  if (extractionLine !== undefined) lines.push(extractionLine);
  for (const field of report.embedGenerationMismatches) {
    lines.push(`embed generation mismatch: ${field}`);
  }
  for (const line of report.processReportLines) {
    lines.push(line);
  }
  for (const gap of report.gaps) {
    lines.push(`gap: ${gap}`);
  }
  return lines.join("\n");
}
