import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { GraphragEnv } from "../config.js";
import { lexicalContractHash } from "../core/storage/elasticsearch-precision.js";
import { DEFAULT_SEARCH_MODE } from "../core/retrieval/search-mode.js";
import { hostnameHash } from "./host-hash.js";

export const UNRESOLVED_RERANK_MODEL = "unresolved";

export const PROCESS_ROLES = ["mcp", "dashboard", "index-worker"] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

export interface ProcessFingerprintInput {
  generationId: string;
  searchMode: string;
  neighborWidth: number;
  rerankAdapter: "llm" | "http";
  rerankModel: string;
  rerankBaseUrl?: string;
  extractProtocol: string;
  extractModel: string;
  extractBaseUrl: string;
  /** Present so a caller can prove a secret is not an input. Never hashed. */
  apiKey?: string;
  /** Present so a caller can prove the dashboard port is not an input. */
  dashboardPort?: number;
}

export interface ProcessFingerprints {
  retrieval: string;
  extraction: string;
  generationId: string;
  epoch: string;
  gaps: readonly string[];
}

export interface StoredProcessReport {
  retrieval: string;
  extraction: string;
  generationId: string;
  epoch: string;
}

export type HealthRequest = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function optionalHostHash(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl.trim() === "") return "";
  return hostnameHash(baseUrl);
}

export function computeProcessFingerprints(
  input: ProcessFingerprintInput
): ProcessFingerprints {
  const epoch = lexicalContractHash();
  const retrieval = digest({
    generationId: input.generationId,
    epoch,
    tokenizerMapping: epoch,
    rerankAdapter: input.rerankAdapter,
    rerankModel: input.rerankModel,
    rerankHostHash: optionalHostHash(input.rerankBaseUrl),
    searchMode: input.searchMode,
    neighborEvidence: `width:${input.neighborWidth}`,
  });
  const extraction = digest({
    protocol: input.extractProtocol,
    model: input.extractModel,
    hostHash: hostnameHash(input.extractBaseUrl),
  });
  const gaps =
    input.rerankModel === UNRESOLVED_RERANK_MODEL
      ? ["rerank model unresolved"]
      : [];
  return {
    retrieval,
    extraction,
    generationId: input.generationId,
    epoch,
    gaps,
  };
}

export function fingerprintsFromEnv(
  env: Pick<GraphragEnv, "llm" | "retrieval" | "rerankUrl">,
  rerankModel: string
): ProcessFingerprints {
  const http = env.rerankUrl !== undefined;
  return computeProcessFingerprints({
    generationId: "1",
    searchMode: DEFAULT_SEARCH_MODE,
    neighborWidth: env.retrieval.neighborWidth,
    rerankAdapter: http ? "http" : "llm",
    rerankModel,
    rerankBaseUrl: http ? env.rerankUrl : env.llm.rerank.baseUrl,
    extractProtocol: env.llm.extract.protocol,
    extractModel: env.llm.extract.model,
    extractBaseUrl: env.llm.extract.baseUrl,
  });
}

export async function readHttpRerankModel(
  rerankUrl: string,
  request: HealthRequest = fetch
): Promise<string> {
  let healthUrl: string;
  try {
    healthUrl = `${new URL(rerankUrl).origin}/health`;
  } catch {
    return UNRESOLVED_RERANK_MODEL;
  }
  try {
    const response = await request(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return UNRESOLVED_RERANK_MODEL;
    return modelId(await response.json());
  } catch {
    return UNRESOLVED_RERANK_MODEL;
  }
}

function modelId(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("model" in payload)
  ) {
    return UNRESOLVED_RERANK_MODEL;
  }
  const model = payload.model;
  if (typeof model !== "string" || model.trim() === "") {
    return UNRESOLVED_RERANK_MODEL;
  }
  return model;
}

export async function writeProcessReport(
  home: string,
  role: ProcessRole,
  report: StoredProcessReport
): Promise<void> {
  const dir = join(home, "process-reports");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${role}.json`),
    JSON.stringify({
      retrieval: report.retrieval,
      extraction: report.extraction,
      generationId: report.generationId,
      epoch: report.epoch,
    })
  );
}

export async function publishProcessReport(
  role: ProcessRole,
  env: Pick<GraphragEnv, "llm" | "retrieval" | "rerankUrl">,
  home: string,
  request?: HealthRequest
): Promise<ProcessFingerprints> {
  const rerankModel =
    env.rerankUrl !== undefined
      ? await readHttpRerankModel(env.rerankUrl, request)
      : env.llm.rerank.model;
  const fingerprints = fingerprintsFromEnv(env, rerankModel);
  await writeProcessReport(home, role, fingerprints);
  return fingerprints;
}

export function describeStoredProcessReports(
  home: string,
  current: { retrieval: string; extraction: string } | undefined
): string[] {
  const lines: string[] = [];
  for (const role of PROCESS_ROLES) {
    const recorded = readStoredReport(home, role);
    if (recorded === null) {
      lines.push(`process report gap: ${role}`);
      continue;
    }
    if (
      current !== undefined &&
      (recorded.retrieval !== current.retrieval ||
        recorded.extraction !== current.extraction)
    ) {
      lines.push(`process report mismatch: ${role}`);
    }
  }
  return lines;
}

function readStoredReport(
  home: string,
  role: ProcessRole
): { retrieval: string; extraction: string } | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, "process-reports", `${role}.json`), "utf8")
    );
    if (parsed === null || typeof parsed !== "object") return null;
    const retrieval = (parsed as { retrieval?: unknown }).retrieval;
    const extraction = (parsed as { extraction?: unknown }).extraction;
    if (typeof retrieval !== "string" || typeof extraction !== "string") {
      return null;
    }
    return { retrieval, extraction };
  } catch {
    return null;
  }
}

export function retrievalEnvelopeFields(identity: {
  retrievalFingerprint: string;
  generationId: string;
  epoch: string;
}): {
  retrieval_fingerprint: string;
  generation_id: string;
  epoch: string;
} {
  return {
    retrieval_fingerprint: identity.retrievalFingerprint,
    generation_id: identity.generationId,
    epoch: identity.epoch,
  };
}
