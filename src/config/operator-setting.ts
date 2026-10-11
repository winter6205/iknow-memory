export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BARE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_STYLE = /^[A-Z][A-Z0-9_]*$/;

const KNOWN_ROOT = new Set([
  "llm",
  "embed",
  "jev",
  "storage",
  "database",
  "elasticsearch",
  "neo4j",
  "pgvector",
]);

const PURPOSES = ["extract", "summary", "rerank"] as const;
type LlmPurposeName = (typeof PURPOSES)[number];

type EnvBag = Readonly<Record<string, string | undefined>>;

interface ProjectedMaps {
  display: Record<string, string>;
  runtime: Record<string, string>;
}

interface Pending {
  name: string;
  runtimeKeys: readonly string[];
}

interface Acc {
  display: Record<string, string>;
  runtime: Record<string, string>;
  pending: Pending[];
}

interface ProjectCtx {
  filePath: string;
  acc: Acc;
}

type FieldBind =
  | { field: string; kind: "text"; keys: readonly string[] }
  | { field: string; kind: "embed-api" }
  | { field: string; kind: "jev-api" }
  | { field: string; kind: "llm-api"; purpose: LlmPurposeName };

interface LeafPatch {
  segments: readonly string[];
  wrapBareName: boolean;
}

interface LeafText {
  text: string;
  name: string | undefined;
}

const EMBED_FIELDS: readonly FieldBind[] = [
  { field: "model", kind: "text", keys: ["GRAPHRAG_MEMORY_EMBED_MODEL"] },
  { field: "baseUrl", kind: "text", keys: ["GRAPHRAG_MEMORY_EMBED_BASE_URL"] },
  {
    field: "dimensions",
    kind: "text",
    keys: ["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"],
  },
  { field: "apiKey", kind: "embed-api" },
];

const JEV_FIELDS: readonly FieldBind[] = [
  { field: "model", kind: "text", keys: ["GRAPHRAG_MEMORY_JEV_MODEL"] },
  { field: "baseUrl", kind: "text", keys: ["GRAPHRAG_MEMORY_JEV_BASE_URL"] },
  { field: "apiKey", kind: "jev-api" },
];

const DATABASE_FIELDS: readonly FieldBind[] = [
  { field: "url", kind: "text", keys: ["GRAPHRAG_MEMORY_DB_URL"] },
];

const ELASTICSEARCH_FIELDS: readonly FieldBind[] = [
  { field: "url", kind: "text", keys: ["GRAPHRAG_MEMORY_ES_URL"] },
];

const NEO4J_FIELDS: readonly FieldBind[] = [
  { field: "uri", kind: "text", keys: ["GRAPHRAG_MEMORY_NEO4J_URI"] },
  { field: "user", kind: "text", keys: ["GRAPHRAG_MEMORY_NEO4J_USER"] },
  { field: "password", kind: "text", keys: ["GRAPHRAG_MEMORY_NEO4J_PASSWORD"] },
];

const PGVECTOR_FIELDS: readonly FieldBind[] = [
  {
    field: "annMaxDimensions",
    kind: "text",
    keys: ["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"],
  },
];

function leaf(segments: readonly string[], wrapBareName = false): LeafPatch {
  return { segments, wrapBareName };
}

const LEAF_PATCHES: Readonly<Record<string, LeafPatch>> = {
  GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL: leaf(["llm", "extract", "model"]),
  GRAPHRAG_MEMORY_ANTHROPIC_MODEL: leaf(["llm", "extract", "model"]),
  GRAPHRAG_MEMORY_LLM_EXTRACT_BASE_URL: leaf(["llm", "extract", "baseUrl"]),
  GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL: leaf(["llm", "extract", "baseUrl"]),
  GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL: leaf(["llm", "extract", "protocol"]),
  GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV: leaf(
    ["llm", "extract", "apiKey"],
    true
  ),
  GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL: leaf(["llm", "summary", "model"]),
  GRAPHRAG_MEMORY_LLM_SUMMARY_BASE_URL: leaf(["llm", "summary", "baseUrl"]),
  GRAPHRAG_MEMORY_LLM_SUMMARY_PROTOCOL: leaf(["llm", "summary", "protocol"]),
  GRAPHRAG_MEMORY_LLM_SUMMARY_API_KEY_ENV: leaf(
    ["llm", "summary", "apiKey"],
    true
  ),
  GRAPHRAG_MEMORY_LLM_RERANK_MODEL: leaf(["llm", "rerank", "model"]),
  GRAPHRAG_MEMORY_LLM_RERANK_BASE_URL: leaf(["llm", "rerank", "baseUrl"]),
  GRAPHRAG_MEMORY_LLM_RERANK_PROTOCOL: leaf(["llm", "rerank", "protocol"]),
  GRAPHRAG_MEMORY_LLM_RERANK_API_KEY_ENV: leaf(["llm", "rerank", "apiKey"], true),
  GRAPHRAG_MEMORY_RERANK_API_KEY_ENV: leaf(["llm", "rerank", "apiKey"], true),
  GRAPHRAG_MEMORY_EMBED_MODEL: leaf(["embed", "model"]),
  GRAPHRAG_MEMORY_EMBED_BASE_URL: leaf(["embed", "baseUrl"]),
  GRAPHRAG_MEMORY_EMBED_DIMENSIONS: leaf(["embed", "dimensions"]),
  GRAPHRAG_MEMORY_EMBED_API_KEY: leaf(["embed", "apiKey"]),
  GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: leaf(["embed", "apiKey"], true),
  GRAPHRAG_MEMORY_JEV_MODEL: leaf(["jev", "model"]),
  GRAPHRAG_MEMORY_JEV_BASE_URL: leaf(["jev", "baseUrl"]),
  GRAPHRAG_MEMORY_JEV_API_KEY: leaf(["jev", "apiKey"]),
  GRAPHRAG_MEMORY_STORAGE: leaf(["storage"]),
  GRAPHRAG_MEMORY_DB_URL: leaf(["database", "url"]),
  GRAPHRAG_MEMORY_ES_URL: leaf(["elasticsearch", "url"]),
  GRAPHRAG_MEMORY_NEO4J_URI: leaf(["neo4j", "uri"]),
  GRAPHRAG_MEMORY_NEO4J_USER: leaf(["neo4j", "user"]),
  GRAPHRAG_MEMORY_NEO4J_PASSWORD: leaf(["neo4j", "password"]),
  GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: leaf([
    "pgvector",
    "annMaxDimensions",
  ]),
};

export function wholePlaceholderName(value: string): string | undefined {
  return PLACEHOLDER.exec(value)?.[1];
}

export function parseSettingJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `${filePath}: not valid JSON (setting.json must be a JSON object of GRAPHRAG_MEMORY_* keys)`
    );
  }
}

export function projectSettingText(
  raw: string,
  filePath: string,
  env: EnvBag = process.env
): ProjectedMaps {
  return projectParsed(parseSettingJson(raw, filePath), filePath, env);
}

export function classifySettingDocument(
  parsed: unknown,
  filePath: string
): "missing" | "flat" | "nested" {
  if (parsed === undefined) return "missing";
  const obj = rootObject(parsed, filePath);
  if (isFlatRoot(obj)) return "flat";
  rejectUnknownRoot(obj, filePath);
  return "nested";
}

export function applyNestedSet(
  parsed: unknown,
  filePath: string,
  key: string,
  value: string
): Record<string, unknown> {
  const root = rootObject(parsed, filePath);
  const patch = LEAF_PATCHES[key];
  if (patch === undefined) throw new ConfigError(`${filePath}: ${key}`);
  const next = structuredClone(root);
  writeLeaf(next, patch.segments, storedLeafValue(patch, value));
  return next;
}

export function applyNestedUnset(
  parsed: unknown,
  key: string
): Record<string, unknown> {
  const root = parsed as Record<string, unknown>;
  const patch = LEAF_PATCHES[key];
  const next = structuredClone(root);
  if (patch === undefined || !leafPresent(next, patch.segments)) return next;
  deleteLeaf(next, patch.segments);
  return next;
}

function projectParsed(
  parsed: unknown,
  filePath: string,
  env: EnvBag
): ProjectedMaps {
  const obj = rootObject(parsed, filePath);
  if (isFlatRoot(obj)) return projectFlat(obj, filePath);
  return projectNested(obj, filePath, env);
}

function rootObject(
  parsed: unknown,
  filePath: string
): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `${filePath}: root must be a JSON object of GRAPHRAG_MEMORY_* keys`
    );
  }
  return parsed as Record<string, unknown>;
}

function isFlatRoot(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).every((key) => !KNOWN_ROOT.has(key));
}

function projectFlat(
  obj: Record<string, unknown>,
  filePath: string
): ProjectedMaps {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "") {
      throw new ConfigError(`${filePath}: setting keys must be non-empty`);
    }
    if (typeof value !== "string") {
      throw new ConfigError(
        `${filePath}: value for "${key}" must be a string, got ${typeof value}`
      );
    }
    out[key] = value;
  }
  return { display: { ...out }, runtime: { ...out } };
}

function projectNested(
  obj: Record<string, unknown>,
  filePath: string,
  env: EnvBag
): ProjectedMaps {
  rejectUnknownRoot(obj, filePath);
  const ctx: ProjectCtx = { filePath, acc: emptyAcc() };
  projectPresentSections(obj, ctx);
  for (const item of ctx.acc.pending) {
    resolvePlaceholder(item, env, ctx.acc.runtime);
  }
  return { display: ctx.acc.display, runtime: ctx.acc.runtime };
}

function emptyAcc(): Acc {
  return { display: {}, runtime: {}, pending: [] };
}

function rejectUnknownRoot(obj: Record<string, unknown>, filePath: string): void {
  const unknown = Object.keys(obj).filter((key) => !KNOWN_ROOT.has(key));
  if (unknown.length === 0) return;
  if (Object.keys(obj).some((key) => KNOWN_ROOT.has(key))) {
    throw new ConfigError(`${filePath}: mixed flat and nested setting`);
  }
  throw unknownRootError(obj, unknown, filePath);
}

function unknownRootError(
  obj: Record<string, unknown>,
  unknown: readonly string[],
  filePath: string
): ConfigError {
  for (const key of unknown) {
    if (ENV_STYLE.test(key) && typeof obj[key] !== "string") {
      return new ConfigError(
        `${filePath}: value for "${key}" must be a string, got ${typeof obj[key]}`
      );
    }
  }
  const key = unknown[0] ?? "root";
  return new ConfigError(`${filePath}: ${key}`);
}

function projectPresentSections(obj: Record<string, unknown>, ctx: ProjectCtx): void {
  projectIfPresent(obj, "storage", ctx, projectStorage);
  projectIfPresent(obj, "llm", ctx, projectLlm);
  projectIfPresent(obj, "embed", ctx, projectEmbed);
  projectIfPresent(obj, "jev", ctx, projectJev);
  projectIfPresent(obj, "database", ctx, projectDatabase);
  projectIfPresent(obj, "elasticsearch", ctx, projectElasticsearch);
  projectIfPresent(obj, "neo4j", ctx, projectNeo4j);
  projectIfPresent(obj, "pgvector", ctx, projectPgvector);
}

function projectIfPresent(
  obj: Record<string, unknown>,
  key: string,
  ctx: ProjectCtx,
  project: (value: unknown, ctx: ProjectCtx) => void
): void {
  const value = obj[key];
  if (value === undefined) return;
  project(value, ctx);
}

function projectStorage(value: unknown, ctx: ProjectCtx): void {
  assignText(value, "storage", ["GRAPHRAG_MEMORY_STORAGE"], ctx);
}

function projectLlm(value: unknown, ctx: ProjectCtx): void {
  const obj = expectObject(value, "llm", ctx.filePath);
  rejectUnknown(obj, new Set<string>(PURPOSES), "llm", ctx.filePath);
  for (const purpose of PURPOSES) {
    if (obj[purpose] === undefined) continue;
    projectObjectSection(obj[purpose], `llm.${purpose}`, llmFields(purpose), ctx);
  }
}

function projectEmbed(value: unknown, ctx: ProjectCtx): void {
  projectObjectSection(value, "embed", EMBED_FIELDS, ctx);
}

function projectJev(value: unknown, ctx: ProjectCtx): void {
  projectObjectSection(value, "jev", JEV_FIELDS, ctx);
}

function projectDatabase(value: unknown, ctx: ProjectCtx): void {
  projectObjectSection(value, "database", DATABASE_FIELDS, ctx);
}

function projectElasticsearch(value: unknown, ctx: ProjectCtx): void {
  projectObjectSection(value, "elasticsearch", ELASTICSEARCH_FIELDS, ctx);
}

function projectNeo4j(value: unknown, ctx: ProjectCtx): void {
  projectObjectSection(value, "neo4j", NEO4J_FIELDS, ctx);
}

function projectPgvector(value: unknown, ctx: ProjectCtx): void {
  projectObjectSection(value, "pgvector", PGVECTOR_FIELDS, ctx);
}

function llmFields(purpose: LlmPurposeName): readonly FieldBind[] {
  const slot = purpose.toUpperCase();
  return [
    { field: "model", kind: "text", keys: modelKeys(purpose) },
    { field: "baseUrl", kind: "text", keys: baseUrlKeys(purpose) },
    {
      field: "protocol",
      kind: "text",
      keys: [`GRAPHRAG_MEMORY_LLM_${slot}_PROTOCOL`],
    },
    { field: "apiKey", kind: "llm-api", purpose },
  ];
}

function modelKeys(purpose: LlmPurposeName): readonly string[] {
  const primary = `GRAPHRAG_MEMORY_LLM_${purpose.toUpperCase()}_MODEL`;
  if (purpose === "extract") return [primary, "GRAPHRAG_MEMORY_ANTHROPIC_MODEL"];
  return [primary];
}

function baseUrlKeys(purpose: LlmPurposeName): readonly string[] {
  const primary = `GRAPHRAG_MEMORY_LLM_${purpose.toUpperCase()}_BASE_URL`;
  if (purpose === "extract") {
    return [primary, "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL"];
  }
  return [primary];
}

function projectObjectSection(
  value: unknown,
  prefix: string,
  fields: readonly FieldBind[],
  ctx: ProjectCtx
): void {
  const obj = expectObject(value, prefix, ctx.filePath);
  rejectUnknown(
    obj,
    new Set(fields.map((field) => field.field)),
    prefix,
    ctx.filePath
  );
  for (const field of fields) assignBound(obj, prefix, field, ctx);
}

function assignBound(
  obj: Record<string, unknown>,
  prefix: string,
  field: FieldBind,
  ctx: ProjectCtx
): void {
  const dotted = `${prefix}.${field.field}`;
  const value = obj[field.field];
  if (field.kind === "text") {
    assignText(value, dotted, field.keys, ctx);
    return;
  }
  if (field.kind === "embed-api") {
    assignEmbedApiKey(value, ctx);
    return;
  }
  if (field.kind === "jev-api") {
    assignJevApiKey(value, ctx);
    return;
  }
  assignLlmApiKey(field.purpose, value, dotted, ctx);
}

function assignText(
  value: unknown,
  dotted: string,
  keys: readonly string[],
  ctx: ProjectCtx
): void {
  const leafText = readLeaf(value, dotted, ctx.filePath);
  if (leafText === undefined) return;
  if (leafText.name === undefined) {
    putBoth(ctx.acc, keys, leafText.text);
    return;
  }
  rememberPlaceholder(ctx.acc, keys, leafText.text, leafText.name);
}

function assignLlmApiKey(
  purpose: LlmPurposeName,
  value: unknown,
  dotted: string,
  ctx: ProjectCtx
): void {
  const leafText = readLeaf(value, dotted, ctx.filePath);
  if (leafText === undefined) return;
  if (leafText.name === undefined) {
    putLlmRaw(ctx.acc, purpose, leafText.text);
    return;
  }
  putLlmPointer(ctx.acc, purpose, leafText.name);
}

function assignEmbedApiKey(value: unknown, ctx: ProjectCtx): void {
  const leafText = readLeaf(value, "embed.apiKey", ctx.filePath);
  if (leafText === undefined) return;
  if (leafText.name === undefined) {
    putBoth(ctx.acc, ["GRAPHRAG_MEMORY_EMBED_API_KEY"], leafText.text);
    return;
  }
  rememberPlaceholder(
    ctx.acc,
    ["GRAPHRAG_MEMORY_EMBED_API_KEY"],
    leafText.text,
    leafText.name
  );
}

function assignJevApiKey(value: unknown, ctx: ProjectCtx): void {
  const leafText = readLeaf(value, "jev.apiKey", ctx.filePath);
  if (leafText === undefined) return;
  if (leafText.name === undefined) {
    putBoth(ctx.acc, ["GRAPHRAG_MEMORY_JEV_API_KEY"], leafText.text);
    return;
  }
  rememberPlaceholder(
    ctx.acc,
    ["GRAPHRAG_MEMORY_JEV_API_KEY"],
    leafText.text,
    leafText.name
  );
}

function putLlmPointer(acc: Acc, purpose: LlmPurposeName, name: string): void {
  const keys = [`GRAPHRAG_MEMORY_LLM_${purpose.toUpperCase()}_API_KEY_ENV`];
  if (purpose === "rerank") keys.push("GRAPHRAG_MEMORY_RERANK_API_KEY_ENV");
  putBoth(acc, keys, name);
}

function putLlmRaw(acc: Acc, purpose: LlmPurposeName, secret: string): void {
  const slot = purpose.toUpperCase();
  const privateName = `__IKNOW_FILE_LLM_${slot}_API_KEY`;
  acc.runtime[`GRAPHRAG_MEMORY_LLM_${slot}_API_KEY_ENV`] = privateName;
  acc.runtime[privateName] = secret;
}

function putBoth(acc: Acc, keys: readonly string[], value: string): void {
  for (const key of keys) {
    acc.display[key] = value;
    acc.runtime[key] = value;
  }
}

function rememberPlaceholder(
  acc: Acc,
  keys: readonly string[],
  raw: string,
  name: string
): void {
  for (const key of keys) acc.display[key] = raw;
  acc.pending.push({ name, runtimeKeys: keys });
}

function resolvePlaceholder(item: Pending, env: EnvBag, runtime: Record<string, string>): void {
  const value = lookupPlaceholder(item.name, env, runtime);
  if (value === undefined) {
    // EXIT: same as an unset *_API_KEY_ENV target — the resolved secret stays unset.
    return;
  }
  for (const key of item.runtimeKeys) runtime[key] = value;
}

function lookupPlaceholder(
  name: string,
  env: EnvBag,
  runtime: Readonly<Record<string, string>>
): string | undefined {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const fromRuntime = runtime[name];
  if (fromRuntime !== undefined && fromRuntime.trim() !== "") return fromRuntime;
  return undefined;
}

function readLeaf(
  value: unknown,
  dotted: string,
  filePath: string
): LeafText | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, dotted, filePath);
  return { text, name: classifyLeaf(text, dotted, filePath) };
}

function requireString(value: unknown, dotted: string, filePath: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${filePath}: ${dotted} must be a string`);
  }
  return value;
}

function classifyLeaf(text: string, dotted: string, filePath: string): string | undefined {
  if (!text.includes("${")) return undefined;
  const name = PLACEHOLDER.exec(text)?.[1];
  if (name === undefined) throw new ConfigError(`${filePath}: ${dotted}`);
  return name;
}

function expectObject(
  value: unknown,
  dotted: string,
  filePath: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${filePath}: ${dotted}`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  filePath: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new ConfigError(`${filePath}: ${prefix}.${key}`);
  }
}

function storedLeafValue(patch: LeafPatch, value: string): string {
  if (patch.wrapBareName && BARE_ENV_NAME.test(value)) return `\${${value}}`;
  return value;
}

function writeLeaf(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: string
): void {
  const parent = ensureParent(root, segments);
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  parent[last] = value;
}

function ensureParent(
  root: Record<string, unknown>,
  segments: readonly string[]
): Record<string, unknown> {
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const seg = segments[index];
    if (seg === undefined) return cursor;
    cursor = childObject(cursor, seg);
  }
  return cursor;
}

function childObject(
  cursor: Record<string, unknown>,
  seg: string
): Record<string, unknown> {
  const next = cursor[seg];
  if (typeof next === "object" && next !== null && !Array.isArray(next)) {
    return next as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  cursor[seg] = created;
  return created;
}

function deleteLeaf(root: Record<string, unknown>, segments: readonly string[]): void {
  const parent = existingParent(root, segments);
  if (parent === undefined) return;
  const last = segments[segments.length - 1];
  if (last !== undefined) delete parent[last];
}

function leafPresent(root: Record<string, unknown>, segments: readonly string[]): boolean {
  const parent = existingParent(root, segments);
  const last = segments[segments.length - 1];
  if (parent === undefined || last === undefined) return false;
  return Object.prototype.hasOwnProperty.call(parent, last);
}

function existingParent(
  root: Record<string, unknown>,
  segments: readonly string[]
): Record<string, unknown> | undefined {
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const seg = segments[index];
    if (seg === undefined) return undefined;
    const next = cursor[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return undefined;
    }
    cursor = next as Record<string, unknown>;
  }
  return cursor;
}
