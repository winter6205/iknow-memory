/**
 * Integrity gate for the frozen long source body
 * (`eval/source-body/g4-long-source-v1.json`, specs/bounded-source-read.md).
 *
 * A later run persists this exact body into real PostgreSQL 16 and walks it
 * back over the real MCP wire, so the file has to stand on its own as the
 * oracle for that reconstruction: the recorded length and digest must follow
 * from the bytes, the body must be too long for one slice, and the first slice
 * boundary must fall inside supplementary-plane text rather than on a
 * surrogate-pair edge. The locator parts must stay individually addressable,
 * because the real-store run proves a neighbouring unit or version is a
 * different row rather than a re-read of this one.
 *
 * Pure: no PostgreSQL, no MCP process, no provider.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SOURCE_READ_MAX_TEXT_CODE_POINTS } from "../../src/tools/read_source.js";

const FIXTURE_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "eval",
  "source-body",
  "g4-long-source-v1.json"
);

const SLICE_LIMIT = SOURCE_READ_MAX_TEXT_CODE_POINTS;

interface SourceBodyGold {
  version: string;
  source_ref: string;
  title: string;
  content: string;
  code_points: number;
  sha256: string;
}

function loadGold(): SourceBodyGold {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as SourceBodyGold;
}

const canonical = (unit: number, version: string): string =>
  `{"document_id":"g4-bounded-read-handbook","unit":${unit},"version":"${version}"}`;

function differingKeys(a: string, b: string): string[] {
  const left = JSON.parse(a) as Record<string, unknown>;
  const right = JSON.parse(b) as Record<string, unknown>;
  return Object.keys(left).filter((key) => left[key] !== right[key]);
}

describe("g4-long-source-v1 source body (bounded read gold)", () => {
  it("parses with exactly the six recorded fields", () => {
    const gold = loadGold();

    expect(Object.keys(gold).sort()).toEqual(
      [
        "code_points",
        "content",
        "sha256",
        "source_ref",
        "title",
        "version",
      ].sort()
    );
    expect(gold.version).toBe("g4-long-source-v1");
    expect(gold.title.length).toBeGreaterThan(0);
  });

  it("is longer than one slice and no longer than the agreed band", () => {
    const gold = loadGold();
    const actual = Array.from(gold.content).length;

    expect(gold.code_points).toBe(actual);
    expect(actual).toBeGreaterThan(SLICE_LIMIT);
    expect(actual).toBeLessThanOrEqual(10_000);
  });

  it("digests to the recorded sha256 over the UTF-8 bytes", () => {
    const gold = loadGold();
    const digest = createHash("sha256")
      .update(Buffer.from(gold.content, "utf8"))
      .digest("hex");

    expect(gold.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(gold.sha256).toBe(digest);
  });

  it("survives a reparse byte-for-byte and carries no lone surrogate", () => {
    const text = readFileSync(FIXTURE_PATH, "utf8");
    const gold = loadGold();

    expect(JSON.stringify(JSON.parse(text), null, 2) + "\n").toBe(text);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(gold.content)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(gold.content)).toBe(
      false
    );
  });

  it("holds the first slice boundary inside a supplementary run", () => {
    const gold = loadGold();
    const points = Array.from(gold.content);

    expect(points[SLICE_LIMIT - 1]?.codePointAt(0)).toBeGreaterThan(0xffff);
    expect(points[SLICE_LIMIT]?.codePointAt(0)).toBeGreaterThan(0xffff);
    expect(gold.content.charCodeAt(SLICE_LIMIT) & 0xfc00).toBe(0xd800);
    expect(
      points
        .slice(SLICE_LIMIT - 30, SLICE_LIMIT + 30)
        .every((c) => (c.codePointAt(0) ?? 0) > 0xffff)
    ).toBe(true);
  });

  it("carries quote, backslash, newline and CJK material verbatim", () => {
    const gold = loadGold();

    expect(gold.content).toContain('"');
    expect(gold.content).toContain("\\");
    expect(gold.content).toContain("\n");
    expect(gold.content.match(/\\"/g)?.length).toBeGreaterThan(0);
    expect(
      gold.content.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length
    ).toBeGreaterThanOrEqual(20);
  });

  it("names a locator whose unit and version are separate parts", () => {
    const gold = loadGold();
    const unitTwo = canonical(2, "3");
    const versionFour = canonical(1, "4");

    expect(gold.source_ref).toBe(canonical(1, "3"));
    expect(gold.source_ref).not.toBe(unitTwo);
    expect(gold.source_ref).not.toBe(versionFour);
    expect(differingKeys(gold.source_ref, unitTwo)).toEqual(["unit"]);
    expect(differingKeys(gold.source_ref, versionFour)).toEqual(["version"]);
    expect(Object.keys(JSON.parse(gold.source_ref)).join(",")).toBe(
      "document_id,unit,version"
    );
  });
});
