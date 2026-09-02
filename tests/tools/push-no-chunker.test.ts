import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..");

/**
 * Plan D0 I-T7: the push path must NEVER chunk the input. The byte
 * round-trip is covered by tests/tools/push.test.ts (4 KB payload
 * comes back identical through search); this file pins the static
 * structure so a chunker can't sneak in via a future refactor.
 *
 * What we lock:
 *  (a) no chunker module exists anywhere in src/
 *  (b) src/tools/push.ts does not import any module that could
 *      rewrite text in fixed windows
 *  (c) src/tools/push.ts does not call any substring / slice on
 *      the input content
 */
describe("push path: no chunker by construction", () => {
  it("src/core/chunker.ts does not exist (a chunker must not be introduced)", () => {
    const chunkerPath = path.join(pkgRoot, "src", "core", "chunker.ts");
    expect(existsSync(chunkerPath)).toBe(false);
  });

  it("no src/** file references a chunker module by name", () => {
    const srcDir = path.join(pkgRoot, "src");
    const offenders = walkSrc(srcDir, (filePath) => {
      if (!filePath.endsWith(".ts")) return false;
      const body = readFileSync(filePath, "utf8");
      // Look for imports/usages of any module whose path contains
      // "chunker". The Plan D0 I-T7 commitment is that no such
      // module exists; a future contributor adding one will trip
      // this guard.
      return (
        /from\s+["'][^"']*chunker/i.test(body) ||
        /require\(["'][^"')]*chunker/i.test(body)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("src/tools/push.ts does not slice / substr the content field", () => {
    const pushPath = path.join(pkgRoot, "src", "tools", "push.ts");
    const body = readFileSync(pushPath, "utf8");
    // A chunker typically manifests as content.slice(...) or
    // content.substr(...) inside the handler. The handler in
    // push.ts never touches the bytes of `content` — it forwards
    // each item verbatim to storage.upsert.
    expect(body).not.toMatch(/\.content\s*\.\s*(slice|substr)\b/);
    expect(body).not.toMatch(/\.content\s*\[\s*[^\]]+\s*:\s*[^\]]+\]/);
  });
});

function walkSrc(
  dir: string,
  predicate: (filePath: string) => boolean
): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const offenders: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      offenders.push(...walkSrc(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      offenders.push(full);
    }
  }
  return offenders;
}
