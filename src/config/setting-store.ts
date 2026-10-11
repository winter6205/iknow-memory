/**
 * Operator-setting file at `~/.iknow-memory/setting.json`.
 * A nested operator document projects onto registry names; a flat string map is stored as written.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { memoryHomeDirectory } from "./memory-home.js";
import {
  applyNestedSet,
  applyNestedUnset,
  classifySettingDocument,
  parseSettingJson,
  projectSettingText,
} from "./operator-setting.js";

/** A flat map of `GRAPHRAG_MEMORY_*` → string. */
export type SettingMap = Readonly<Record<string, string>>;

/** Minimal async store the resolver and the config CLI share. */
export interface SettingStore {
  /** Path on disk — exposed so error messages can name it. */
  readonly path: string;
  /**
   * Read the current map. An absent file (or absent parent directory) is
   * `{}` — never an error, never a block on start. A malformed or invalid
   * document is a typed error so an operator typo surfaces at the boot
   * boundary, not as a confusing empty-string at the use site.
   */
  read(): Promise<SettingMap>;
  /** Replace the on-disk map with `next`. */
  write(next: SettingMap): Promise<void>;
  setKey(key: string, value: string): Promise<void>;
  unsetKey(key: string): Promise<void>;
}

export interface CreateSettingStoreOptions {
  /**
   * Override `$HOME`. Production callers leave this undefined so the store
   * follows the operator's actual home directory; tests inject a tmp
   * tree so the real `~/.iknow-memory/setting.json` is never read or
   * written by a test.
   */
  home?: string;
}

const FILE_NAME = "setting.json";

/** Resolve the directory that holds `setting.json`. */
function storeDirectory(options: CreateSettingStoreOptions): string {
  if (options.home !== undefined) return memoryHomeDirectory(options.home);
  return memoryHomeDirectory(null);
}

/** Validate an in-memory map the CLI is about to persist. */
function assertWriteableMap(next: SettingMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    if (key === "") {
      throw new Error(`${FILE_NAME}: setting keys must be non-empty`);
    }
    if (typeof value !== "string") {
      throw new Error(
        `${FILE_NAME}: value for "${key}" must be a string, got ${typeof value}`
      );
    }
    out[key] = value;
  }
  return out;
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readSettingText(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw new Error(`${path}: failed to read (${(err as Error).message})`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readSetting(path: string): Promise<SettingMap> {
  const raw = await readSettingText(path);
  if (raw === undefined) return {};
  return projectSettingText(raw, path).display;
}

async function writeSetting(path: string, next: SettingMap): Promise<void> {
  await writeJson(path, assertWriteableMap(next));
}

async function readParsedSetting(path: string): Promise<unknown | undefined> {
  const raw = await readSettingText(path);
  if (raw === undefined) return undefined;
  return parseSettingJson(raw, path);
}

async function setSettingKey(
  path: string,
  key: string,
  value: string
): Promise<void> {
  const parsed = await readParsedSetting(path);
  const kind = classifySettingDocument(parsed, path);
  if (kind === "nested") {
    await writeJson(path, applyNestedSet(parsed, path, key, value));
    return;
  }
  const current = kind === "flat" ? (parsed as Record<string, string>) : {};
  await writeSetting(path, { ...current, [key]: value });
}

async function unsetSettingKey(path: string, key: string): Promise<void> {
  const parsed = await readParsedSetting(path);
  if (parsed === undefined) return;
  const kind = classifySettingDocument(parsed, path);
  if (kind !== "nested") {
    await unsetFlat(path, parsed as Record<string, string>, key);
    return;
  }
  const next = applyNestedUnset(parsed, key);
  if (JSON.stringify(next) === JSON.stringify(parsed)) return;
  await writeJson(path, next);
}

async function unsetFlat(
  path: string,
  current: Record<string, string>,
  key: string
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(current, key)) return;
  const next = { ...current };
  delete next[key];
  await writeSetting(path, next);
}

/**
 * Build a store rooted at `home/.iknow-memory/setting.json`. Production
 * callers pass nothing (default home = `$HOME`); tests inject a tmp dir.
 */
export function createSettingStore(
  options: CreateSettingStoreOptions = {}
): SettingStore {
  const path = join(storeDirectory(options), FILE_NAME);
  return {
    path,
    read: () => readSetting(path),
    write: (next) => writeSetting(path, next),
    setKey: (key, value) => setSettingKey(path, key, value),
    unsetKey: (key) => unsetSettingKey(path, key),
  };
}
