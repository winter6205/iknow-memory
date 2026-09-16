/**
 * Operator-setting file store — read/write of `~/.iknow-memory/setting.json`.
 *
 * Shape: a flat object whose keys are the existing `GRAPHRAG_MEMORY_*` env
 * var names and whose values are strings. The mapping is 1:1 with the
 * env-vars the rest of `config.ts` already understands, so the resolver
 * (src/config/setting-resolver.ts) can fall back to a key lookup with no
 * new naming scheme.
 *
 * Why a custom shape: the spec is explicit — keys stay
 * `GRAPHRAG_MEMORY_*` (no migration to a friendlier namespace this wave).
 * A nested object would force every consumer to re-derive the env name,
 * defeating the purpose. Numeric / array / nested values are rejected
 * with a typed error so a hand-edit typo (`{"GRAPHRAG_MEMORY_DB_URL": 42}`)
 * cannot become "loaded with `undefined`" or "loaded with
 * `[object Object]`" downstream.
 *
 * No new runtime dependency: this module only uses `node:fs` /
 * `node:path`. The package's lockfile is not touched by T2.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** A flat map of `GRAPHRAG_MEMORY_*` → string. */
export type SettingMap = Readonly<Record<string, string>>;

/** Minimal async store the resolver and the config CLI share. */
export interface SettingStore {
  /** Path on disk — exposed so error messages can name it. */
  readonly path: string;
  /**
   * Read the current map. An absent file (or absent parent directory) is
   * `{}` — never an error, never a block on start. A malformed file or a
   * non-flat value is a typed error so an operator typo surfaces at the
   * boot boundary, not as a confusing empty-string at the use site.
   */
  read(): Promise<SettingMap>;
  /** Replace the on-disk map with `next`. */
  write(next: SettingMap): Promise<void>;
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
const DIR_NAME = ".iknow-memory";

/** Resolve `home/.iknow-memory/setting.json`. */
function defaultPath(home: string): string {
  return join(home, DIR_NAME, FILE_NAME);
}

/**
 * Walk every value in `parsed` and confirm it's a non-empty-key string.
 * Throws a typed error naming the offending key. Returning the validated
 * map keeps the read path small — no second pass.
 */
function assertFlatStringMap(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${FILE_NAME}: root must be a JSON object of GRAPHRAG_MEMORY_* keys, got ${typeof parsed}`
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "") {
      throw new Error(`${FILE_NAME}: setting keys must be non-empty`);
    }
    if (typeof v !== "string") {
      throw new Error(
        `${FILE_NAME}: value for "${k}" must be a string, got ${typeof v}`
      );
    }
    out[k] = v;
  }
  return out;
}

/** Validate an in-memory map the CLI is about to persist. */
function assertWriteableMap(next: SettingMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === "") {
      throw new Error(`${FILE_NAME}: setting keys must be non-empty`);
    }
    if (typeof v !== "string") {
      throw new Error(
        `${FILE_NAME}: value for "${k}" must be a string, got ${typeof v}`
      );
    }
    out[k] = v;
  }
  return out;
}

/**
 * Build a store rooted at `home/.iknow-memory/setting.json`. Production
 * callers pass nothing (default home = `$HOME`); tests inject a tmp dir.
 */
export function createSettingStore(
  options: CreateSettingStoreOptions = {}
): SettingStore {
  const home = options.home ?? process.env.HOME ?? "";
  const path = defaultPath(home);
  return {
    path,
    async read(): Promise<SettingMap> {
      if (!existsSync(path)) return {};
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        // ENOENT can race with `existsSync` (deleted between check and
        // read); collapse to "absent" so the no-block contract holds.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new Error(`${path}: failed to read (${(err as Error).message})`);
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(
          `${path}: not valid JSON (${FILE_NAME} must be a JSON object of GRAPHRAG_MEMORY_* keys)`
        );
      }
      return assertFlatStringMap(json);
    },
    async write(next: SettingMap): Promise<void> {
      const validated = assertWriteableMap(next);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(validated, null, 2) + "\n", "utf8");
    },
  };
}
