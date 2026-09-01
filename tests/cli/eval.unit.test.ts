/**
 * Eval CLI unit tests (specs/p0-eval.md E-T6).
 *
 * Covers the surface contracts the spec pins on the eval entry point:
 *
 *   - Subcommand dispatch + flag parsing (--gold-build / --audit-rejects /
 *     --bootstrap / --gate pr / --gate release).
 *   - Exit codes 0 / 1 / 2 (A16): success, ConfigError/fatal, usage error
 *     or gate tripped (SC16).
 *   - Cross-family guard (SC9): --gold-build and --audit-rejects refuse
 *     when the gold / audit model id equals the extract model id.
 *   - SC14: --gate pr with no baseline file exits 0.
 *   - SC12: --gate release before thresholds lock exits 1 with a clear
 *     ConfigError.
 *   - SC19: --gold-build overwrites the same ruler's gold file; no
 *     leftover triples from a previous run survive.
 *   - SC20: --audit-rejects writes only the three allowed labels.
 *   - SC3 / A14 isolation: the eval entry must not import
 *     `src/tools/*`, `src/index.ts`, or `src/core/retrieval/*`.
 *
 * Tests run with FakeLLMClient and an injected scratch baseline dir; no
 * live LLM, no Postgres, no Neo4j.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  parseArgs,
  runCli,
  AUDIT_LABELS,
  type AuditEntry,
  type AuditLLMClient,
  type AuditReport,
  type EvalCliDeps,
} from "../../src/cli/eval.js";
import {
  loadChunkSnapshot,
  type ChunkSnapshot,
  type GoldSet,
  type SnapshotChunk,
} from "../../src/core/extraction-eval/index.js";
import {
  appendBaseline,
  baselineFilePath,
  readBaseline,
  readThresholds,
  thresholdsFilePath,
  writeThresholds,
  type BaselineEntry,
  type LockedThresholds,
} from "../../src/core/extraction-eval/baseline.js";
import {
  driftGate,
  releaseGate,
  extractThresholds,
  type Axes,
  type BaselineEntry as GateBaselineEntry,
  type DriftResult,
  type ReleaseResult,
  type ReleaseThresholds,
} from "../../src/core/extraction-eval/gate.js";
import { parseGoldSet } from "../../src/core/extraction-eval/gold.js";
import {
  FakeLLMClient,
  type LLMClient,
} from "../../src/core/extraction/llm-client.js";
import type { Logger } from "../../src/logging.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                 */
/* ------------------------------------------------------------------------ */

const SNAPSHOT_ID = "extraction-snapshot-eval-cli-v1";
const EXTRACT_MODEL = "extractor-MiniMax-M3";
const GOLD_MODEL = "gold-llm-cross-family-v1";
const AUDIT_MODEL = "audit-llm-cross-family-v1";
const PROMPT = "produce gold triples from the following chunk:";
const SNAPSHOT_PROMPT_HASH = sha256Hex(PROMPT);

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function silentLogger(): Logger {
  const noop = (): void => {};
  return { level: "error", debug: noop, info: noop, warn: noop, error: noop };
}

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-eval-cli-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/* ------------------------------------------------------------------------ */
/* Snapshot fixture                                                         */
/* ------------------------------------------------------------------------ */

/** Build a 12-chunk snapshot (inside the SC8 band). */
function snapshotFixture(): ChunkSnapshot {
  const chunks: SnapshotChunk[] = Array.from({ length: 12 }, (_, i) => ({
    id: `chunk-${i + 1}`,
    content: `Alice works for Acme in sentence ${i + 1}.`,
    source_ref: `doc-a#${i + 1}`,
  }));
  return { id: SNAPSHOT_ID, chunks };
}

function snapshotPath(dir: string): string {
  const p = join(dir, "snapshot.json");
  writeFileSync(p, JSON.stringify(snapshotFixture()), "utf8");
  return p;
}

function writeSnapshotFile(dir: string): {
  path: string;
  snapshot: ChunkSnapshot;
} {
  const path = snapshotPath(dir);
  return { path, snapshot: snapshotFixture() };
}

/* ------------------------------------------------------------------------ */
/* FakeAuditLLMClient                                                       */
/* ------------------------------------------------------------------------ */

type AuditLabel = "agree-filter" | "filter-false-reject" | "gold-miss";

class FakeAuditLLMClient implements AuditLLMClient {
  private head = 0;
  constructor(
    private readonly queue: ReadonlyArray<AuditLabel>,
    private readonly defaultLabel: AuditLabel = "agree-filter"
  ) {}
  async audit(): Promise<AuditLabel> {
    if (this.head < this.queue.length) {
      const value = this.queue[this.head]!;
      this.head += 1;
      return value;
    }
    return this.defaultLabel;
  }
}

/* ------------------------------------------------------------------------ */
/* deps helpers                                                             */
/* ------------------------------------------------------------------------ */

interface DepsOverrides {
  llmClient?: LLMClient;
  llmAuditClient?: AuditLLMClient;
  extractModelId?: string;
  baselineDir?: string;
  saveGold?: (path: string, set: GoldSet) => Promise<void>;
  saveAudit?: (path: string, report: AuditReport) => Promise<void>;
}

function defaultDeps(dir: string, over: DepsOverrides = {}): EvalCliDeps {
  return {
    llmClient: over.llmClient ?? new FakeLLMClient({ queue: [] }),
    llmAuditClient: over.llmAuditClient ?? new FakeAuditLLMClient([]),
    extractModelId: over.extractModelId ?? EXTRACT_MODEL,
    baselineDir: over.baselineDir ?? dir,
    loadSnapshot: loadChunkSnapshot,
    loadGold: (path: string): GoldSet => {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return parseGoldSet(parsed, path);
    },
    saveGold:
      over.saveGold ??
      (async (path: string, set: GoldSet) => {
        mkdirSync(dirnameOf(path), { recursive: true });
        writeFileSync(path, JSON.stringify(set, null, 2) + "\n", "utf8");
      }),
    saveAudit:
      over.saveAudit ??
      (async (path: string, report: AuditReport) => {
        mkdirSync(dirnameOf(path), { recursive: true });
        writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
      }),
    appendBaseline,
    readBaseline,
    readThresholds,
    driftGate,
    releaseGate,
    extractThresholds,
    hashPrompt: sha256Hex,
    logger: silentLogger(),
    now: () => "2026-09-01T00:00:00.000Z",
  };
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/* ------------------------------------------------------------------------ */
/* parseArgs                                                                */
/* ------------------------------------------------------------------------ */

describe("parseArgs — subcommand + flags", () => {
  it("parses --gold-build with defaults", () => {
    const parsed = parseArgs(["--gold-build"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.subcommand).toBe("gold-build");
  });

  it("parses --audit-rejects", () => {
    const parsed = parseArgs(["--audit-rejects"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.subcommand).toBe("audit-rejects");
  });

  it("parses --bootstrap", () => {
    const parsed = parseArgs(["--bootstrap"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.subcommand).toBe("bootstrap");
  });

  it("parses --gate pr", () => {
    const parsed = parseArgs(["--gate", "pr"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.subcommand).toBe("gate-pr");
  });

  it("parses --gate release", () => {
    const parsed = parseArgs(["--gate", "release"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.subcommand).toBe("gate-release");
  });

  it("rejects an unknown flag (exit 2 → usage error)", () => {
    const parsed = parseArgs(["--nope"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--nope");
  });

  it("rejects a subcommand-less invocation", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("rejects --gate without the pr/release argument", () => {
    const parsed = parseArgs(["--gate"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--gate");
  });

  it("rejects --gate followed by an unknown arm", () => {
    const parsed = parseArgs(["--gate", "wat"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--gate");
  });
});

/* ------------------------------------------------------------------------ */
/* SC9 cross-family guard                                                   */
/* ------------------------------------------------------------------------ */

describe("--gold-build cross-family guard (SC9)", () => {
  it("exits 1 (ConfigError) when gold model id equals extract model id", async () => {
    const dir = scratchDir();
    const snapPath = snapshotPath(dir);
    const stderr = captureStderr();

    const code = await runCli(
      [
        "--gold-build",
        "--snapshot",
        snapPath,
        "--out",
        join(dir, "gold.json"),
        "--gold-model",
        EXTRACT_MODEL, // same as extract
      ],
      defaultDeps(dir)
    );
    stderr.restore();

    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/config/i);
    expect(stderr.text()).toContain(EXTRACT_MODEL);
  });
});

describe("--audit-rejects cross-family guard (SC9)", () => {
  it("exits 1 (ConfigError) when audit model id equals extract model id", async () => {
    const dir = scratchDir();
    const { path: snapPath } = writeSnapshotFile(dir);

    // Pre-write a gold file so the audit subcommand reaches the cross-family guard.
    const goldPath = join(dir, "gold.json");
    const gold: GoldSet = {
      snapshot_id: SNAPSHOT_ID,
      gold_model: GOLD_MODEL,
      prompt_hash: SNAPSHOT_PROMPT_HASH,
      triples: [],
    };
    writeFileSync(goldPath, JSON.stringify(gold), "utf8");

    const stderr = captureStderr();

    const code = await runCli(
      [
        "--audit-rejects",
        "--gold",
        goldPath,
        "--snapshot",
        snapPath,
        "--out",
        join(dir, "audit.json"),
        "--audit-model",
        EXTRACT_MODEL, // same as extract
      ],
      defaultDeps(dir)
    );
    stderr.restore();

    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/config/i);
  });
});

/* ------------------------------------------------------------------------ */
/* --gate pr with no baseline (SC14)                                        */
/* ------------------------------------------------------------------------ */

describe("--gate pr with no baseline (SC14)", () => {
  it("exits 0 when the baseline file does not exist", async () => {
    const dir = scratchDir();
    const code = await runCli(["--gate", "pr"], defaultDeps(dir));
    expect(code).toBe(0);
  });

  it("exits 0 when the baseline file exists but has only one entry", async () => {
    const dir = scratchDir();
    const entry: BaselineEntry = {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.5, schemaRate: 1, hallucinationRate: 0 },
      recordedAt: "2026-09-01T00:00:00.000Z",
    };
    await appendBaseline(dir, entry);

    const code = await runCli(["--gate", "pr"], defaultDeps(dir));
    expect(code).toBe(0);
  });

  it("exits 0 when |ΔF1| is at the 0.05 boundary", async () => {
    const dir = scratchDir();
    // baseline at f1=0.50, current at f1=0.55 — drift 0.05 → pass
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.5, schemaRate: 1, hallucinationRate: 0 },
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.55, schemaRate: 1, hallucinationRate: 0 },
      recordedAt: "2026-09-01T00:05:00.000Z",
    });

    const code = await runCli(["--gate", "pr"], defaultDeps(dir));
    expect(code).toBe(0);
  });

  it("exits 2 when |ΔF1| exceeds 0.05", async () => {
    const dir = scratchDir();
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.8, schemaRate: 1, hallucinationRate: 0 },
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.5, schemaRate: 1, hallucinationRate: 0 }, // -0.30 drift → fail
      recordedAt: "2026-09-01T00:05:00.000Z",
    });

    const code = await runCli(["--gate", "pr"], defaultDeps(dir));
    expect(code).toBe(2);
  });
});

/* ------------------------------------------------------------------------ */
/* --gate release before lock (SC12)                                        */
/* ------------------------------------------------------------------------ */

describe("--gate release before thresholds lock (SC12)", () => {
  it("exits 1 with ConfigError when no thresholds file is on disk", async () => {
    const dir = scratchDir();
    // need at least one baseline entry to reach the thresholds check
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.5, schemaRate: 1, hallucinationRate: 0 },
      recordedAt: "2026-09-01T00:00:00.000Z",
    });

    const stderr = captureStderr();
    const code = await runCli(["--gate", "release"], defaultDeps(dir));
    stderr.restore();

    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/threshold/i);
    expect(stderr.text()).toMatch(/lock/i);
  });

  it("exits 0 when thresholds pass", async () => {
    const dir = scratchDir();
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.8, schemaRate: 1, hallucinationRate: 0 },
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    await writeThresholds(dir, {
      f1Minimum: 0.7,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.1,
    });

    const code = await runCli(["--gate", "release"], defaultDeps(dir));
    expect(code).toBe(0);
  });

  it("exits 2 when thresholds fail", async () => {
    const dir = scratchDir();
    await appendBaseline(dir, {
      snapshotId: SNAPSHOT_ID,
      modelId: GOLD_MODEL,
      promptHash: SNAPSHOT_PROMPT_HASH,
      axes: { f1: 0.3, schemaRate: 0.5, hallucinationRate: 0.8 },
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    await writeThresholds(dir, {
      f1Minimum: 0.7,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.1,
    });

    const code = await runCli(["--gate", "release"], defaultDeps(dir));
    expect(code).toBe(2);
  });
});

/* ------------------------------------------------------------------------ */
/* --gold-build overwrite (SC19)                                            */
/* ------------------------------------------------------------------------ */

describe("--gold-build overwrite (SC19)", () => {
  it("drops triples from the previous run on a same-ruler overwrite", async () => {
    const dir = scratchDir();
    const { path: snapPath } = writeSnapshotFile(dir);
    const goldPath = join(dir, "gold.json");

    // First run: FakeLLM produces triple "alpha" on every chunk.
    // Scripted mode (one triple per chunk call) so the FakeLLMClient
    // queue never exhausts on the snapshot's 12 chunks.
    const firstLlm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok",
        outputs: [
          {
            head: "alpha",
            headType: "person",
            relationRaw: "owns",
            relationNorm: "owns",
            tail: "beta",
            tailType: "organization",
            description: "alpha owns beta.",
            evidenceSpan: "Alice works for Acme",
            confidence: 0.9,
          },
        ],
      }),
    });
    const code1 = await runCli(
      [
        "--gold-build",
        "--snapshot",
        snapPath,
        "--out",
        goldPath,
        "--gold-model",
        GOLD_MODEL,
        "--prompt",
        PROMPT,
      ],
      defaultDeps(dir, { llmClient: firstLlm })
    );
    expect(code1).toBe(0);
    const first = readJson<GoldSet>(goldPath);
    expect(first.gold_model).toBe(GOLD_MODEL);
    expect(first.prompt_hash).toBe(SNAPSHOT_PROMPT_HASH);
    const firstTripleHeads = first.triples.map((t) => t.head);
    expect(firstTripleHeads).toContain("alpha");

    // Second run, SAME ruler (snapshot+model+prompt-hash), different LLM output.
    const secondLlm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok",
        outputs: [
          {
            head: "gamma",
            headType: "person",
            relationRaw: "works for",
            relationNorm: "works_for",
            tail: "delta",
            tailType: "organization",
            description: "gamma works for delta.",
            evidenceSpan: "Alice works for Acme",
            confidence: 0.95,
          },
        ],
      }),
    });
    const code2 = await runCli(
      [
        "--gold-build",
        "--snapshot",
        snapPath,
        "--out",
        goldPath,
        "--gold-model",
        GOLD_MODEL,
        "--prompt",
        PROMPT,
      ],
      defaultDeps(dir, { llmClient: secondLlm })
    );
    expect(code2).toBe(0);
    const second = readJson<GoldSet>(goldPath);
    const secondTripleHeads = second.triples.map((t) => t.head);
    // SC19: leftovers from the previous run must not survive the overwrite.
    expect(secondTripleHeads).not.toContain("alpha");
    expect(secondTripleHeads).toContain("gamma");
  });
});

/* ------------------------------------------------------------------------ */
/* --audit-rejects label whitelist (SC20)                                   */
/* ------------------------------------------------------------------------ */

describe("--audit-rejects writes only the three allowed labels (SC20)", () => {
  it("writes exactly the three allowed labels in the output", async () => {
    const dir = scratchDir();
    const { path: snapPath } = writeSnapshotFile(dir);

    // Pre-write a gold file with rejected triples (the audit only operates on rejects).
    const gold: GoldSet = {
      snapshot_id: SNAPSHOT_ID,
      gold_model: GOLD_MODEL,
      prompt_hash: SNAPSHOT_PROMPT_HASH,
      triples: [
        {
          head: "alice chen",
          relation_norm: "works_for",
          tail: "acme corp",
          evidence_span: "Alice works for Acme",
          confidence: 0.9,
          provenance: {
            model_id: GOLD_MODEL,
            prompt_hash: SNAPSHOT_PROMPT_HASH,
            chunk_id: "chunk-1",
            raw_output: "{}",
            filter_verdict: "reject",
            filter_reason: "no-grounding",
          },
        },
        {
          head: "bob",
          relation_norm: "works_for",
          tail: "widgets",
          evidence_span: "Bob builds widgets",
          confidence: 0.85,
          provenance: {
            model_id: GOLD_MODEL,
            prompt_hash: SNAPSHOT_PROMPT_HASH,
            chunk_id: "chunk-2",
            raw_output: "{}",
            filter_verdict: "reject",
            filter_reason: "negated",
          },
        },
        {
          head: "carol",
          relation_norm: "works_for",
          tail: "dna labs",
          evidence_span: "Carol builds DNA labs",
          confidence: 0.8,
          provenance: {
            model_id: GOLD_MODEL,
            prompt_hash: SNAPSHOT_PROMPT_HASH,
            chunk_id: "chunk-3",
            raw_output: "{}",
            filter_verdict: "reject",
            filter_reason: "no-grounding",
          },
        },
      ],
    };
    const goldPath = join(dir, "gold.json");
    writeFileSync(goldPath, JSON.stringify(gold), "utf8");

    const auditOut = join(dir, "audit.json");
    const auditClient = new FakeAuditLLMClient(
      ["agree-filter", "filter-false-reject", "gold-miss"],
      "agree-filter"
    );

    const code = await runCli(
      [
        "--audit-rejects",
        "--gold",
        goldPath,
        "--snapshot",
        snapPath,
        "--out",
        auditOut,
        "--audit-model",
        AUDIT_MODEL,
      ],
      defaultDeps(dir, { llmAuditClient: auditClient })
    );
    expect(code).toBe(0);

    const report = readJson<AuditReport>(auditOut);
    expect(report.audit_model).toBe(AUDIT_MODEL);
    expect(report.entries).toHaveLength(3);
    for (const entry of report.entries) {
      // SC20: every label must be in the whitelist of three.
      expect(AUDIT_LABELS).toContain(entry.label);
    }
    // The fixture specifically exercises all three labels.
    const labels = report.entries.map((e) => e.label).sort();
    expect(labels).toEqual(
      ["agree-filter", "filter-false-reject", "gold-miss"].sort()
    );
  });

  it("throws ConfigError when the audit model id equals the extract model id", async () => {
    const dir = scratchDir();
    const { path: snapPath } = writeSnapshotFile(dir);
    const gold: GoldSet = {
      snapshot_id: SNAPSHOT_ID,
      gold_model: GOLD_MODEL,
      prompt_hash: SNAPSHOT_PROMPT_HASH,
      triples: [],
    };
    const goldPath = join(dir, "gold.json");
    writeFileSync(goldPath, JSON.stringify(gold), "utf8");
    const stderr = captureStderr();
    const code = await runCli(
      [
        "--audit-rejects",
        "--gold",
        goldPath,
        "--snapshot",
        snapPath,
        "--out",
        join(dir, "audit.json"),
        "--audit-model",
        EXTRACT_MODEL,
      ],
      defaultDeps(dir)
    );
    stderr.restore();
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/config/i);
  });
});

/* ------------------------------------------------------------------------ */
/* --bootstrap                                                             */
/* ------------------------------------------------------------------------ */

describe("--bootstrap records axes for the same ruler", () => {
  it("appends one entry per run and exits 0", async () => {
    const dir = scratchDir();
    const { path: snapPath } = writeSnapshotFile(dir);

    // 12 chunks — each gets a response from the queue.
    const queue = Array.from({ length: 12 }, (_, i) => ({
      kind: "ok" as const,
      outputs: [
        {
          head: `head-${i + 1}`,
          headType: "person",
          relationRaw: "works for",
          relationNorm: "works_for",
          tail: `tail-${i + 1}`,
          tailType: "organization",
          description: `head-${i + 1} works for tail-${i + 1}.`,
          evidenceSpan: "Alice works for Acme",
          confidence: 0.9,
        },
      ],
    }));
    const llm = new FakeLLMClient({ queue });

    // Bootstrap needs a gold file (the predictions are scored against gold).
    const gold: GoldSet = {
      snapshot_id: SNAPSHOT_ID,
      gold_model: GOLD_MODEL,
      prompt_hash: SNAPSHOT_PROMPT_HASH,
      triples: [],
    };
    const goldPath = join(dir, "gold.json");
    writeFileSync(goldPath, JSON.stringify(gold), "utf8");

    const code = await runCli(
      [
        "--bootstrap",
        "--snapshot",
        snapPath,
        "--gold",
        goldPath,
        "--model",
        GOLD_MODEL,
      ],
      defaultDeps(dir, { llmClient: llm })
    );
    expect(code).toBe(0);
    const entries = readBaseline(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.modelId).toBe(GOLD_MODEL);
    expect(entries[0]!.snapshotId).toBe(SNAPSHOT_ID);
    expect(entries[0]!.axes.f1).toBeGreaterThanOrEqual(0);
    expect(entries[0]!.axes.f1).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------------ */
/* SC3 / A14 isolation guard                                                */
/* ------------------------------------------------------------------------ */

describe("eval CLI isolation (SC3 / A14)", () => {
  it("does not import from src/tools, src/index, or src/core/retrieval/*", () => {
    const cliPath = join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "cli",
      "eval.ts"
    );
    const src = readFileSync(cliPath, "utf8");
    const forbidden: RegExp[] = [
      /from\s+["'][^"']*core\/retrieval\//,
      /from\s+["'][^"']*src\/tools\//,
      /from\s+["'][^"']*src\/index(?:\.js)?["']/,
    ];
    const hits: string[] = [];
    for (const re of forbidden) {
      const m = src.match(re);
      if (m) hits.push(m[0]);
    }
    if (hits.length > 0) {
      throw new Error(
        `src/cli/eval.ts imports from a forbidden module: ${hits.join("; ")}. ` +
          `Eval CLI must stay isolated from Host/MCP and retrieval surfaces (specs/p0-eval.md SC3, A14).`
      );
    }
    expect(hits).toEqual([]);
  });
});
