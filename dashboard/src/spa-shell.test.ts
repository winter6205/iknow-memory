import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTheme, parseTheme, useThemeStore } from "./theme/store";
import { NAV_ITEMS, WORDMARK } from "./chrome/brand";
import { dashboardApiProxyTarget } from "./vite-proxy";

const dashboardRoot = resolve(import.meta.dirname, "..");

function readDashboard(rel: string): string {
  return readFileSync(resolve(dashboardRoot, rel), "utf8");
}

describe("Vite bind and port", () => {
  it("listens on 127.0.0.1:18868 and does not use 5173", () => {
    const src = readDashboard("vite.config.ts");
    expect(src).toMatch(/host:\s*["']127\.0\.0\.1["']/);
    expect(src).toMatch(/port:\s*18868/);
    expect(src).not.toMatch(/port:\s*5173/);
  });

  it("proxies /api to the dashboard-api port from GRAPHRAG_MEMORY_DASHBOARD_PORT", () => {
    expect(dashboardApiProxyTarget({})).toBe("http://127.0.0.1:4174");
    expect(
      dashboardApiProxyTarget({ GRAPHRAG_MEMORY_DASHBOARD_PORT: "4199" })
    ).toBe("http://127.0.0.1:4199");
    expect(readDashboard("vite.config.ts")).not.toMatch(
      /target:\s*["']http:\/\/127\.0\.0\.1:4174["']/
    );
  });

  it("does not ship unused PlaceholderPage", () => {
    expect(
      existsSync(resolve(dashboardRoot, "src/pages/PlaceholderPage.tsx"))
    ).toBe(false);
  });
});

describe("theme tokens", () => {
  it("defaults to 冷墨 and switches CSS variables to 晨纸", () => {
    useThemeStore.setState({ theme: "冷墨" });
    expect(useThemeStore.getState().theme).toBe("冷墨");

    useThemeStore.getState().setTheme("晨纸");
    expect(useThemeStore.getState().theme).toBe("晨纸");

    const root = { dataset: {} as Record<string, string> };
    applyTheme("晨纸", root);
    expect(root.dataset.theme).toBe("晨纸");
  });

  it("rejects empty and illegal theme names", () => {
    expect(() => parseTheme("")).toThrow(/theme/i);
    expect(() => parseTheme("teal")).toThrow(/theme/i);
    expect(parseTheme("冷墨")).toBe("冷墨");
    expect(parseTheme("晨纸")).toBe("晨纸");
  });

  it("ships 冷墨 and 晨纸 role tokens from the palette SSOT", () => {
    const css = readDashboard("src/index.css");
    expect(css).toContain("#0e1218");
    expect(css).toContain("#e8e4d9");
    expect(css).toContain("#eee6d8");
    expect(css).toContain("#3d7ea6");
    expect(css).toContain("rgba(138, 164, 184, 0.35)");
    expect(css).toContain("#f3f1ea");
    expect(css).toContain("#1c1e22");
    expect(css).toMatch(/\[data-theme=["']晨纸["']\]/);
  });
});

describe("chrome", () => {
  it("uses the iknow-memory wordmark and three named fonts", () => {
    expect(WORDMARK).toBe("iknow-memory");
    expect(readDashboard("src/chrome/Chrome.tsx")).toMatch(
      /iknow<span[^>]*>-memory<\/span>/
    );
    const html = readDashboard("index.html");
    expect(html).toMatch(/Playfair[+ ]Display/);
    expect(html).toMatch(/Space[+ ]Grotesk/);
    expect(html).toMatch(/Fira[+ ]Code/);
  });

  it("hosts routes for the six operator surfaces", () => {
    const paths = NAV_ITEMS.map((item) => item.path);
    expect(paths).toEqual([
      "/",
      "/sources",
      "/import",
      "/browse",
      "/timeline",
      "/graph",
    ]);
  });

  it("keeps operator-board header order: wordmark, nav, typeahead", () => {
    const src = readDashboard("src/chrome/Chrome.tsx");
    const logo = src.indexOf('data-testid="header-logo"');
    const nav = src.indexOf('data-testid="header-nav"');
    const search = src.indexOf('data-testid="header-search-cell"');
    expect(logo).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(logo);
    expect(search).toBeGreaterThan(nav);
    expect(src).toMatch(/grid-cols-\[auto_1fr_auto_auto\]/);
    expect(src).toMatch(/header-nav[\s\S]*header-search/);
  });
});
