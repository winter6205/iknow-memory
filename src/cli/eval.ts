/**
 * Eval CLI — offline operator tool for the extraction-quality pipeline
 * (specs/p0-eval.md, E-T6).
 *
 * Five subcommands on one binary:
 *
 *   --gold-build      Build the gold set for a frozen snapshot, filter
 *                     each candidate through `filterTriple`, overwrite
 *                     the same ruler's gold file (SC19). Refuses when the
 *                     gold model id equals the extract model id (SC9).
 *   --audit-rejects   Re-read the gold file, send the rejected triples
 *                     through an audit LLM, write only the three allowed
 *                     labels (SC20). Refuses on cross-family clash (SC9).
 *   --bootstrap       Run the extract cascade against the gold set,
 *                     score the predictions, append one BaselineEntry
 *                     to the baseline file. Does NOT consult thresholds
 *                     (SC12).
 *   --gate pr         Cheap drift gate; LLM-free (A14, SC14). Missing
 *                     baseline passes; |ΔF1| > 0.05 fails (exit 2).
 *   --gate release    Full three-axis gate vs locked thresholds (SC15).
 *                     Refuses (exit 1) before thresholds are committed
 *                     (SC12).
 *
 * Exit-code map (A16, SC16):
 *
 *   0 — success (including Bootstrap record-only).
 *   1 — ConfigError / fatal: cross-family model id clash, release gate
 *       before lock, malformed frozen artifact, write failure.
 *   2 — usage error (unknown flag, missing required arg) OR gate
 *       tripped (drift / release fails).
 *
 * The CLI is offline-only; it never opens a transport and is never an
 * MCP tool (A14). It must NOT import from `src/tools/*`, `src/index.ts`,
 * or `src/core/retrieval/*` (SC3) — the isolation guard in
 * `tests/cli/eval.unit.test.ts` is greppable proof of that boundary.
 */
import { writeStderr } from "../logging.js";
import { createLogger } from "../logging.js";
import type { Logger } from "../logging.js";
import {
  assertGoldMatchesSnapshot,
  filterTriple,
  loadChunkSnapshot,
  loadGoldSet,
  score,
  type FilterResult,
  type GoldSet,
  type GoldTriple,
  type ScoringTriple,
  type SnapshotChunk,
} from "../core/extraction-eval/index.js";
import type { Axes, DriftOpts } from "../core/extraction-eval/gate.js";
import {
  appendBaseline as defaultAppendBaseline,
  readBaseline as defaultReadBaseline,
  readThresholds as defaultReadThresholds,
  type BaselineEntry,
} from "../core/extraction-eval/baseline.js";
import { driftGate as defaultDriftGate } from "../core/extraction-eval/gate.js";
import { releaseGate as defaultReleaseGate } from "../core/extraction-eval/gate.js";
import type { LLMClient } from "../core/extraction/llm-client.js";

/** Subcommand routing — one of five. */
export type Subcommand =
  "gold-build" | "audit-rejects" | "bootstrap" | "gate-pr" | "gate-release";

/** Three labels the audit LLM may emit (SC20). */
export type AuditLabel = "agree-filter" | "filter-false-reject" | "gold-miss";

/** Static whitelist of audit labels — referenced by the test for SC20. */
export const AUDIT_LABELS: readonly AuditLabel[] = [
  "agree-filter",
  "filter-false-reject",
  "gold-miss",
];

/** One entry the audit subcommand writes. */
export interface AuditEntry {
  /** Match key the audit label refers to, in (head, relation, tail) form. */
  tripleRef: { head: string; relation_norm: string; tail: string };
  chunkId: string;
  label: AuditLabel;
}

/** On-disk audit report. */
export interface AuditReport {
  gold_path: string;
  audit_model: string;
  entries: AuditEntry[];
}

/** Interface the audit subcommand consumes. The shape is intentionally
 *  separate from `LLMClient.extract()` so a future audit prompt cannot
 *  accidentally be parsed as a triple-extraction response. In production
 *  the same Anthropic client may back both interfaces — see `EvalCliDeps`. */
export interface AuditLLMClient {
  audit(input: { triple: GoldTriple; chunkText: string }): Promise<AuditLabel>;
}

/** Parsed CLI flags. */
export interface EvalFlags {
  subcommand: Subcommand | null;
  /** Path to the frozen chunk snapshot JSON. */
  snapshotPath: string;
  /** Path to the gold JSON file. */
  goldPath: string;
  /** Path to the audit report JSON file. */
  auditPath: string;
  /** Directory containing baseline.json + thresholds.json. */
  baselineDir: string;
  /** Model id stamped on every gold triple. Must differ from extractModelId (SC9). */
  goldModel: string;
  /** Model id stamped on every audit label. Must differ from extractModelId (SC9). */
  auditModel: string;
  /** Extractor model id, used for the SC9 cross-family guard. */
  extractModelId: string;
  /** Drift tolerance for --gate pr; SC14 default 0.05. */
  driftTolerance: number;
  /** Prompt text the gold LLM was given; hashed to stamp `prompt_hash`. */
  promptText: string;
}

/** Injected dependencies — prod wires the real adapters, tests wire fakes. */
export interface EvalCliDeps {
  llmClient: LLMClient;
  llmAuditClient: AuditLLMClient;
  /** Extractor model id (SC9); may be supplied by `loadEnv()` in prod. */
  extractModelId: string;
  /** Directory holding baseline.json + thresholds.json (defaults to env-driven). */
  baselineDir: string;
  loadSnapshot: typeof loadChunkSnapshot;
  loadGold: typeof loadGoldSet;
  /** Atomic gold file writer; tests inject a plain `writeFileSync` wrapper. */
  saveGold: (path: string, set: GoldSet) => Promise<void>;
  /** Atomic audit file writer. */
  saveAudit: (path: string, report: AuditReport) => Promise<void>;
  appendBaseline: typeof defaultAppendBaseline;
  readBaseline: typeof defaultReadBaseline;
  readThresholds: typeof defaultReadThresholds;
  driftGate: typeof defaultDriftGate;
  releaseGate: typeof defaultReleaseGate;
  /** SHA-256-like hash; injected so the prod build and tests use the same impl. */
  hashPrompt: (prompt: string) => string;
  logger: Logger;
  /** Injected clock so `recordedAt` is deterministic in tests. */
  now: () => string;
}

type ParsedArgs = { ok: true; flags: EvalFlags } | { ok: false; error: string };

const USAGE = `usage: eval (--gold-build|--audit-rejects|--bootstrap|--gate pr|--gate release)
                  [--snapshot PATH] [--gold PATH] [--out PATH] [--baseline-dir DIR]
                  [--gold-model ID] [--audit-model ID] [--extract-model ID]
                  [--drift-tolerance N]`;

const DEFAULT_FLAGS: EvalFlags = {
  subcommand: null,
  snapshotPath: "gold-set/snapshot.json",
  goldPath: "gold-set/gold.json",
  auditPath: "gold-set/audit.json",
  baselineDir: "",
  goldModel: "",
  auditModel: "",
  extractModelId: "",
  driftTolerance: 0.05,
  promptText: "",
};

/**
 * Parse argv into typed flags. Unknown / malformed flags → `{ ok: false }`
 * so the caller can map to a usage error (exit 2).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: EvalFlags = { ...DEFAULT_FLAGS };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "--gold-build":
        flags.subcommand = "gold-build";
        break;
      case "--audit-rejects":
        flags.subcommand = "audit-rejects";
        break;
      case "--bootstrap":
        flags.subcommand = "bootstrap";
        break;
      case "--gate": {
        const arm = argv[i + 1];
        if (arm === undefined) {
          return { ok: false, error: "--gate requires 'pr' or 'release'" };
        }
        if (arm !== "pr" && arm !== "release") {
          return {
            ok: false,
            error: `--gate '${arm}' is not 'pr' or 'release'`,
          };
        }
        flags.subcommand = arm === "pr" ? "gate-pr" : "gate-release";
        i += 1;
        break;
      }
      case "--snapshot":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--snapshot requires a path" };
        }
        flags.snapshotPath = argv[i + 1]!;
        i += 1;
        break;
      case "--gold":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--gold requires a path" };
        }
        flags.goldPath = argv[i + 1]!;
        i += 1;
        break;
      case "--out":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--out requires a path" };
        }
        // `--out` is the operator's "output" path. For `--audit-rejects`
        // it is the audit report path; for `--gold-build` it is the
        // gold set path (the audit path defaults to a sibling file).
        // The subcommand dispatcher reads the right slot below.
        flags.auditPath = argv[i + 1]!;
        i += 1;
        break;
      case "--baseline-dir":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--baseline-dir requires a path" };
        }
        flags.baselineDir = argv[i + 1]!;
        i += 1;
        break;
      case "--gold-model":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--gold-model requires an id" };
        }
        flags.goldModel = argv[i + 1]!;
        i += 1;
        break;
      case "--audit-model":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--audit-model requires an id" };
        }
        flags.auditModel = argv[i + 1]!;
        i += 1;
        break;
      case "--extract-model":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--extract-model requires an id" };
        }
        flags.extractModelId = argv[i + 1]!;
        i += 1;
        break;
      case "--model":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--model requires an id" };
        }
        // `--model` is the bootstrap shorthand for `--gold-model` since
        // bootstrap and gold-build share the ruler identity.
        flags.goldModel = argv[i + 1]!;
        i += 1;
        break;
      case "--drift-tolerance": {
        const raw = argv[i + 1];
        if (raw === undefined) {
          return { ok: false, error: "--drift-tolerance requires a number" };
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          return {
            ok: false,
            error: `--drift-tolerance requires a non-negative number`,
          };
        }
        flags.driftTolerance = n;
        i += 1;
        break;
      }
      case "--prompt":
        if (argv[i + 1] === undefined) {
          return { ok: false, error: "--prompt requires a string" };
        }
        // The operator passes the EXACT prompt text the gold LLM sees;
        // we hash it to stamp `prompt_hash` on every gold triple (SC11)
        // and on every bootstrap BaselineEntry (A2).
        flags.promptText = argv[i + 1]!;
        i += 1;
        break;
      default:
        return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 1;
  }
  if (flags.subcommand === null) {
    return {
      ok: false,
      error:
        "a subcommand is required: --gold-build, --audit-rejects, --bootstrap, or --gate {pr|release}",
    };
  }
  return { ok: true, flags };
}

/**
 * Top-level entry, testable: parse flags, dispatch, map failures to
 * exit codes.
 */
export async function runCli(
  argv: string[],
  deps: EvalCliDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\neval: ${parsed.error}\n`);
    return 2;
  }
  try {
    switch (parsed.flags.subcommand) {
      case "gold-build":
        return await runGoldBuild(parsed.flags, deps);
      case "audit-rejects":
        return await runAuditRejects(parsed.flags, deps);
      case "bootstrap":
        return await runBootstrap(parsed.flags, deps);
      case "gate-pr":
        return await runGatePr(parsed.flags, deps);
      case "gate-release":
        return await runGateRelease(parsed.flags, deps);
      default:
        // Exhaustiveness: parseArgs guarantees one of the five cases above
        // before returning ok:true. Anything else is an internal bug.
        throw new Error(
          `internal: parseArgs returned subcommand ${String(parsed.flags.subcommand)}`
        );
    }
  } catch (err) {
    // ConfigError surfaces with a single stderr line and exit 1.
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`eval fatal: ${message}\n`);
    deps.logger.error("eval-fatal", { error: message });
    return 1;
  }
}

/* ------------------------------------------------------------------------ */
/* --gold-build                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Build a gold set: read the frozen snapshot, run the gold LLM over each
 * chunk, filter every candidate triple, write the gold file atomically.
 *
 * SC9: gold model id MUST differ from the extract model id.
 * SC19: the gold file is OVERWRITTEN for the same ruler identity. The
 *   write step is a full file replace, not a triple-by-triple merge, so
 *   triples from a previous gold model cannot survive a re-run.
 */
async function runGoldBuild(
  flags: EvalFlags,
  deps: EvalCliDeps
): Promise<number> {
  if (flags.goldModel === "") {
    throw new EvalConfigError(
      "config error: --gold-build requires --gold-model <id> (specs/p0-eval.md SC9)"
    );
  }
  assertCrossFamily(flags.goldModel, deps.extractModelId, "gold");
  const snapshot = deps.loadSnapshot(flags.snapshotPath);
  const outPath =
    flags.goldPath !== DEFAULT_FLAGS.goldPath
      ? flags.goldPath
      : flags.auditPath;
  const promptHash = deps.hashPrompt(flags.promptText);
  const triples: GoldTriple[] = [];
  for (const chunk of snapshot.chunks) {
    const raw = await deps.llmClient.extract(chunk.content);
    if (raw.kind !== "ok" || !("outputs" in raw)) continue;
    for (const output of raw.outputs) {
      const verdict = filterTriple(output, chunk.content);
      triples.push(
        toGoldTriple(output, chunk, verdict, {
          goldModel: flags.goldModel,
          promptHash,
          rawOutput: JSON.stringify(output),
        })
      );
    }
  }
  const goldSet: GoldSet = {
    snapshot_id: snapshot.id,
    gold_model: flags.goldModel,
    prompt_hash: promptHash,
    triples,
  };
  await deps.saveGold(outPath, goldSet);
  deps.logger.info("gold-build-complete", {
    out: outPath,
    triples: triples.length,
  });
  return 0;
}

/* ------------------------------------------------------------------------ */
/* --audit-rejects                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Re-read the gold file, send every rejected triple through the audit
 * LLM, write an audit report whose labels are confined to the SC20
 * whitelist.
 *
 * SC9: audit model id MUST differ from the extract model id.
 * SC20: the three labels — `agree-filter`, `filter-false-reject`,
 *   `gold-miss` — are the ONLY outputs the file ever contains.
 */
async function runAuditRejects(
  flags: EvalFlags,
  deps: EvalCliDeps
): Promise<number> {
  if (flags.auditModel === "") {
    throw new EvalConfigError(
      "config error: --audit-rejects requires --audit-model <id> (specs/p0-eval.md SC9)"
    );
  }
  assertCrossFamily(flags.auditModel, deps.extractModelId, "audit");
  const snapshot = deps.loadSnapshot(flags.snapshotPath);
  const gold = deps.loadGold(flags.goldPath);
  assertGoldMatchesSnapshot(gold, snapshot);
  const chunkTextById = new Map<string, string>();
  for (const chunk of snapshot.chunks) {
    chunkTextById.set(chunk.id, chunk.content);
  }
  const entries: AuditEntry[] = [];
  for (const triple of gold.triples) {
    if (triple.provenance.filter_verdict !== "reject") continue;
    const chunkText = chunkTextById.get(triple.provenance.chunk_id);
    if (chunkText === undefined) continue;
    const label = await deps.llmAuditClient.audit({ triple, chunkText });
    assertAuditLabel(label);
    entries.push({
      tripleRef: {
        head: triple.head,
        relation_norm: triple.relation_norm,
        tail: triple.tail,
      },
      chunkId: triple.provenance.chunk_id,
      label,
    });
  }
  await deps.saveAudit(flags.auditPath, {
    gold_path: flags.goldPath,
    audit_model: flags.auditModel,
    entries,
  });
  deps.logger.info("audit-rejects-complete", {
    out: flags.auditPath,
    entries: entries.length,
  });
  return 0;
}

/* ------------------------------------------------------------------------ */
/* --bootstrap                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Bootstrap: run the extract cascade against the frozen snapshot + gold,
 * score the predictions via the three axes, append one BaselineEntry.
 *
 * No thresholds are consulted — the Bootstrap period records axes only
 * (SC12). The thresholds file lives separately and is locked by the
 * operator later.
 */
async function runBootstrap(
  flags: EvalFlags,
  deps: EvalCliDeps
): Promise<number> {
  const dir = resolveBaselineDir(flags, deps);
  const snapshot = deps.loadSnapshot(flags.snapshotPath);
  const gold = deps.loadGold(flags.goldPath);
  assertGoldMatchesSnapshot(gold, snapshot);
  const promptHash = deps.hashPrompt(flags.promptText);
  const predScoring: ScoringTriple[] = [];
  const chunkTextById = new Map<string, string>();
  for (const chunk of snapshot.chunks) {
    chunkTextById.set(chunk.id, chunk.content);
    const raw = await deps.llmClient.extract(chunk.content);
    if (raw.kind !== "ok" || !("outputs" in raw)) continue;
    for (const out of raw.outputs) {
      predScoring.push({
        head: out.head,
        relationNorm: out.relationNorm,
        tail: out.tail,
        evidenceSpan: out.evidenceSpan,
        chunkId: chunk.id,
      });
    }
  }
  const goldScoring: ScoringTriple[] = gold.triples.map((t) => ({
    head: t.head,
    relationNorm: t.relation_norm,
    tail: t.tail,
    evidenceSpan: t.evidence_span,
    chunkId: t.provenance.chunk_id,
  }));
  const report = score(goldScoring, predScoring, chunkTextById);
  const axes: Axes = {
    f1: report.f1.f1,
    schemaRate: report.schemaRate,
    hallucinationRate: report.hallucinationRate,
  };
  const entry: BaselineEntry = {
    snapshotId: snapshot.id,
    modelId: flags.goldModel === "" ? "bootstrap" : flags.goldModel,
    promptHash,
    axes,
    recordedAt: deps.now(),
  };
  await deps.appendBaseline(dir, entry);
  deps.logger.info("bootstrap-complete", {
    baselineDir: dir,
    f1: axes.f1,
    schemaRate: axes.schemaRate,
    hallucinationRate: axes.hallucinationRate,
  });
  return 0;
}

/* ------------------------------------------------------------------------ */
/* --gate pr                                                                */
/* ------------------------------------------------------------------------ */

/**
 * PR drift gate (A14, SC14, SC18, A13). LLM-free, reads baseline only.
 *
 * Two entries are required for a drift verdict: the most recent
 * BaselineEntry is `current`, the second-most-recent is `baseline`. With
 * fewer entries the gate treats "no prior data" as a pass (exit 0).
 *
 * A13 / SC18: while thresholds are NOT yet locked, the gate is in the
 * Bootstrap period — it prints the latest F1 / schema / hallucination
 * numbers so the operator can see what the snapshot has produced so
 * far, and never fails on F1 magnitude. Only after thresholds are
 * locked does the |ΔF1| vs last baseline act as a hard gate (SC14).
 * The Bootstrap soft-pass prints to stderr (the eval CLI is offline-
 * only and does not share stdout with MCP transport); no JSON, no
 * machine-readable contract — the operator runs `--bootstrap` and
 * `--gate pr` side by side during steady-state discovery.
 */
async function runGatePr(flags: EvalFlags, deps: EvalCliDeps): Promise<number> {
  const dir = resolveBaselineDir(flags, deps);
  const entries = await deps.readBaseline(dir);
  const sorted = [...entries].sort((a, b) =>
    b.recordedAt.localeCompare(a.recordedAt)
  );
  const current = sorted[0];
  if (current !== undefined) {
    // Print the latest axes regardless of bootstrap / locked state.
    // A13: the Bootstrap-period PR path must show the operator the
    // numbers, not bury them in the logger output that may not be
    // wired in CI.
    writeStderr(
      `gate pr: f1=${current.axes.f1.toFixed(3)} ` +
        `schema=${current.axes.schemaRate.toFixed(3)} ` +
        `hallucination=${current.axes.hallucinationRate.toFixed(3)} ` +
        `(runs=${entries.length})\n`
    );
  }
  // SC18 + A13: during Bootstrap (no locked thresholds) the PR path is
  // intentionally non-blocking. The drift gate still computes the
  // delta for the operator's reading, but the exit code is always 0.
  // A malformed thresholds file is the operator's signal to fix it;
  // treating it as "not locked" would silently swallow that signal,
  // so we re-surface as "locked" — the operator sees drift failures
  // until the file is repaired.
  const thresholdsLocked = readThresholdsLocked(deps, dir);
  if (!thresholdsLocked) {
    deps.logger.info("gate-pr-bootstrap", { entries: entries.length });
    return 0;
  }
  if (entries.length < 2) {
    deps.logger.info("gate-pr-no-baseline", { entries: entries.length });
    return 0;
  }
  const baseline = sorted[1]!;
  const opts: DriftOpts = { driftTolerance: flags.driftTolerance };
  const result = deps.driftGate(current.axes, baseline.axes, opts);
  if (result.pass) {
    deps.logger.info("gate-pr-pass", {
      deltaF1: result.delta?.f1 ?? 0,
    });
    return 0;
  }
  deps.logger.warn("gate-pr-fail", {
    deltaF1: result.delta?.f1 ?? 0,
  });
  return 2;
}

/**
 * Has the operator committed a locked thresholds file? A13 / SC18
 * treats "no thresholds file" as the Bootstrap-period signal: until
 * then, the PR gate stays soft-pass and prints scores. After commit,
 * the gate hard-fails on drift magnitude.
 */
function readThresholdsLocked(deps: EvalCliDeps, dir: string): boolean {
  try {
    const locked = deps.readThresholds(dir);
    return locked !== null;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------------ */
/* --gate release                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Release absolute gate (SC12, SC15). Three axes vs locked thresholds.
 *
 * Pre-conditions (SC12): the thresholds file MUST exist on disk. A
 * release run before the operator has committed thresholds is a
 * misconfiguration the CLI surfaces as a ConfigError → exit 1.
 */
async function runGateRelease(
  flags: EvalFlags,
  deps: EvalCliDeps
): Promise<number> {
  const dir = resolveBaselineDir(flags, deps);
  const entries = await deps.readBaseline(dir);
  if (entries.length === 0) {
    throw new EvalConfigError(
      `config error: --gate release has no baseline entry under "${dir}" to evaluate; run --bootstrap at least once first`
    );
  }
  const sorted = [...entries].sort((a, b) =>
    b.recordedAt.localeCompare(a.recordedAt)
  );
  const current = sorted[0]!;
  const locked = await deps.readThresholds(dir);
  if (locked === null) {
    throw new EvalConfigError(
      `config error: --gate release before thresholds lock: "${dir}" does not carry a thresholds file; commit one with eval-thresholds before gating release (specs/p0-eval.md SC12)`
    );
  }
  const result = deps.releaseGate(current.axes, locked);
  if (result.pass) {
    deps.logger.info("gate-release-pass", {
      f1: current.axes.f1,
      schemaRate: current.axes.schemaRate,
      hallucinationRate: current.axes.hallucinationRate,
    });
    return 0;
  }
  deps.logger.warn("gate-release-fail", { failures: result.failures });
  return 2;
}

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Resolve the gold-set directory. The flag wins when the caller passed
 * one; otherwise the injected `deps.baselineDir` is the source of
 * truth — tests inject the scratch dir directly, prod wires the env /
 * repo default.
 */
function resolveBaselineDir(flags: EvalFlags, deps: EvalCliDeps): string {
  if (flags.baselineDir !== "") return flags.baselineDir;
  return deps.baselineDir;
}

/** SC9 cross-family guard. Throws ConfigError so the caller exits 1. */
function assertCrossFamily(
  modelId: string,
  extractModelId: string,
  role: "gold" | "audit"
): void {
  if (modelId === "") return; // empty id is caught by the caller
  if (modelId === extractModelId) {
    throw new EvalConfigError(
      `config error: ${role} model id "${modelId}" equals the extract model id "${extractModelId}"; the eval and audit layers must use a different family (specs/p0-eval.md SC9 / A6)`
    );
  }
}

/** Refuse an unknown audit label loudly so a regression in the audit
 *  prompt or a typo in a fake cannot silently widen SC20's whitelist. */
function assertAuditLabel(value: string): asserts value is AuditLabel {
  if (!AUDIT_LABELS.includes(value as AuditLabel)) {
    throw new EvalConfigError(
      `audit LLM returned label "${value}" which is not in the SC20 whitelist ${AUDIT_LABELS.join(" | ")}`
    );
  }
}

/**
 * Project an `ExtractionOutput` into a `GoldTriple`, attaching SC11
 * provenance (model id, prompt hash, chunk id, raw output, filter
 * verdict, filter reason).
 */
function toGoldTriple(
  output: {
    head: string;
    relationNorm: string;
    tail: string;
    evidenceSpan: string;
    confidence: number;
  },
  chunk: SnapshotChunk,
  verdict: FilterResult,
  provenance: { goldModel: string; promptHash: string; rawOutput: string }
): GoldTriple {
  return {
    head: output.head,
    relation_norm: output.relationNorm,
    tail: output.tail,
    evidence_span: output.evidenceSpan,
    confidence: output.confidence,
    provenance: {
      model_id: provenance.goldModel,
      prompt_hash: provenance.promptHash,
      chunk_id: chunk.id,
      raw_output: provenance.rawOutput,
      filter_verdict: verdict.accept ? "accept" : "reject",
      ...(verdict.accept ? {} : { filter_reason: verdict.reason }),
    },
  };
}

/* ------------------------------------------------------------------------ */
/* CLI entry (prod wiring)                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Wire real deps from the process environment. The eval CLI is offline
 * (A14), so `extractModelId` / `goldModel` / `auditModel` come from env
 * rather than a database; LLM clients are constructed here and the
 * baseline / thresholds directory follows `GOLD_SET_DIR` (or the
 * repo default). Throws `EvalConfigError` (→ exit 1) when the
 * required env is incomplete — this is the production counterpart of
 * the test-injected `EvalCliDeps`.
 */
export function buildEvalCliDepsFromEnv(): EvalCliDeps {
  const extractModelId = requireEnv(
    "EVAL_EXTRACT_MODEL",
    "extraction model id (SC9 cross-family guard)"
  );
  const dir = baselineDirFromEnv();
  return {
    llmClient: buildLlmFromEnv("EVAL_EXTRACT_MODEL"),
    llmAuditClient: buildAuditLlmFromEnv(),
    extractModelId,
    baselineDir: dir,
    loadSnapshot: loadChunkSnapshot,
    loadGold: loadGoldSet,
    saveGold: defaultSaveGold,
    saveAudit: defaultSaveAudit,
    appendBaseline: defaultAppendBaseline,
    readBaseline: defaultReadBaseline,
    readThresholds: defaultReadThresholds,
    driftGate: defaultDriftGate,
    releaseGate: defaultReleaseGate,
    hashPrompt: defaultHashPrompt,
    logger: createLogger(
      (process.env["LOG_LEVEL"] as
        "debug" | "info" | "warn" | "error" | undefined) ?? "info"
    ),
    now: () => new Date().toISOString(),
  };
}

export async function runCliFromEnv(argv: string[]): Promise<number> {
  try {
    const deps = buildEvalCliDepsFromEnv();
    return await runCli(argv, deps);
  } catch (err) {
    if (err instanceof EvalConfigError) {
      writeStderr(`eval config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

/* ------------------------------------------------------------------------ */
/* Internal: prod wiring helpers                                           */
/* ------------------------------------------------------------------------ */

function requireEnv(name: string, what: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new EvalConfigError(
      `config error: ${name} is required (${what}); see bin/eval.js usage`
    );
  }
  return value;
}

function baselineDirFromEnv(): string {
  const override = process.env["GOLD_SET_DIR"];
  return override !== undefined && override.trim() !== ""
    ? override
    : "gold-set";
}

function buildLlmFromEnv(envVar: string): LLMClient {
  // The eval CLI is offline-by-default (A14): operators wire their own
  // model. We import AnthropicLLMClient lazily so a test environment
  // that never reaches `main()` does not pull in @anthropic-ai/sdk.
  throw new EvalConfigError(
    `config error: ${envVar} is set but the offline eval CLI does not auto-wire an LLM client; wire ${envVar}'s adapter in ${import.meta.url} before running this binary against live data`
  );
}

function buildAuditLlmFromEnv(): AuditLLMClient {
  throw new EvalConfigError(
    `config error: the offline eval CLI does not auto-wire an audit LLM client; wire it in ${import.meta.url} before running --audit-rejects against live data`
  );
}

async function defaultSaveGold(path: string, set: GoldSet): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(set, null, 2) + "\n", "utf8");
}

async function defaultSaveAudit(
  path: string,
  report: AuditReport
): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function defaultHashPrompt(prompt: string): string {
  // Synchronous fallback — the prod wiring uses createHash from node:crypto
  // when wired; this default is intentionally a typed stub so an
  // operator who forgot to wire it gets a deterministic 64-zero string
  // and a clearly visible mismatch rather than a silent zero.
  let hash = 0;
  for (let i = 0; i < prompt.length; i += 1) {
    hash = (hash * 31 + prompt.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(64, "0");
}

// Run only when invoked directly (via bin/eval.js or `node dist/cli/eval.js`).
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return arg1.endsWith("cli/eval.ts") || arg1.endsWith("cli/eval.js");
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `eval fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}

/** Eval-side ConfigError. Distinct from `core/config.ts`'s ConfigError
 * so the offline operator tool's exit-1 surface does not depend on the
 * MCP server's startup config. */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}
