/**
 * Operator-setting resolver — single-key precedence:
 *
 *   1. process.env presence (even blank) → wins, normalized to undefined if blank
 *   2. setting.json value (string)
 *   3. undefined
 *
 * Why this lives in its own module: it is the bridge between the
 * setting-store (`src/config/setting-store.ts`) and the env-reading
 * surface in `src/config.ts`. Splitting it out keeps the store I/O
 * concern (disk shape, atomic writes) separate from the precedence
 * concern (which side of `process.env > file > absent` wins), and lets
 * the integration tests assert precedence without touching real env.
 *
 * The resolver is a pure function over an injected store + an
 * env-bag. `src/config.ts` threads the live `process.env` into it;
 * tests inject a plain `Record<string, string|undefined>`.
 */
import type { SettingStore } from "./setting-store.js";

/** Shape the resolver reads instead of touching real `process.env`. */
export type EnvBag = Readonly<Record<string, string | undefined>>;

/**
 * Resolve one `GRAPHRAG_MEMORY_*` key.
 *
 * Order (first non-undefined wins):
 *   1. `process.env[key]` — a present non-blank value is the explicit
 *      shell choice and wins outright. A present *blank* value is
 *      normalized to undefined so it cannot shadow a real file value;
 *      this matches the existing `readEnv` convention in
 *      `src/config.ts` (a stray `export FOO=` must not beat the
 *      operator's actual setting).
 *   2. file value — the operator's `~/.iknow-memory/setting.json` entry.
 *   3. undefined — the caller falls back to its next-layer default
 *      (`.env.local` for legacy tests, or the document default).
 *
 * Missing file → empty store → step 2 always returns undefined → no
 * thrown error, never a block on start.
 */
export async function resolveSettingValue(
  key: string,
  env: EnvBag,
  store: SettingStore
): Promise<string | undefined> {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    const fromEnv = env[key];
    if (fromEnv !== undefined) {
      const trimmed = fromEnv.trim();
      if (trimmed !== "") return fromEnv;
      // Present-but-blank collapses to "absent" — fall through to the
      // file lookup so a stray `export FOO=` cannot shadow a real
      // operator setting.
    }
  }
  const map = await store.read();
  const fromFile = map[key];
  if (fromFile === undefined) return undefined;
  // A blank string in the file is also "absent" — a stray "" in the
  // JSON must not be returned as a literal empty value downstream.
  return fromFile.trim() === "" ? undefined : fromFile;
}
