/**
 * Architectural guards for T2: no MCP client, no dashboard-local SQL SSOT.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DASHBOARD_API = join(ROOT, "src", "dashboard-api");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("dashboard-api isolation (T2)", () => {
  it("does not import an MCP client or spawn stdio MCP", () => {
    const files = walkTs(DASHBOARD_API);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (
        /@modelcontextprotocol\/client/.test(src) ||
        /from\s+["'][^"']*tools\/registry/.test(src) ||
        /StdioServerTransport/.test(src) ||
        /tools\/call/.test(src)
      ) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });

  it("does not contain dashboard-local SQL as a read SSOT", () => {
    const files = walkTs(DASHBOARD_API);
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/SELECT\s+/i.test(src) || /FROM\s+chunks/i.test(src)) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});
