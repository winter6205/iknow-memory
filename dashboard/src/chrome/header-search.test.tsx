/**
 * T7 SPA — header typeahead filters 资料 `title` / `source_ref` in-process,
 * selects to navigate to that 资料's detail. Does NOT call retrieve /
 * embedder; the only network fetch is the /api/sources summaries list.
 *
 * Spec assumption 10: "Header typeahead filters 资料 title / source_ref
 * in-process (or a cheap list read). It does not call retrieve and does
 * not embed."
 *
 * No-retrieve proof is pinned by intercepting fetch and asserting no
 * call to /api/query (the only retrieve-touched endpoint in this repo).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// vis-network is required transitively by App (GraphPage). Mirror the
// mock in spa-pages.test.tsx so the full-App test below can mount.
vi.mock("vis-network/standalone", () => ({
  Network: class {
    destroy() {}
  },
  DataSet: class {
    constructor(_items: unknown) {}
  },
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { Chrome } from "./Chrome";

const DOC_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DOC_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOC_C_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DOC_D_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockFetch(handler: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url);
    })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function summariesResponse() {
  return {
    items: [
      {
        id: DOC_A_ID,
        source_ref: "docs/first.md",
        title: "第一条",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      },
      {
        id: DOC_B_ID,
        source_ref: "docs/second.md",
        title: "第二条",
        created_at: "2026-01-02T00:00:00.000Z",
        valid_until: null,
      },
      {
        id: DOC_C_ID,
        source_ref: "docs/no-title.md",
        title: null,
        created_at: "2026-01-03T00:00:00.000Z",
        valid_until: null,
      },
      {
        id: DOC_D_ID,
        source_ref: "docs/closed.md",
        title: "已失效",
        created_at: "2026-01-04T00:00:00.000Z",
        valid_until: "2026-06-01T00:00:00.000Z",
      },
    ],
    total: 4,
    limit: 100,
    offset: 0,
  };
}

describe("Chrome header search (typeahead)", () => {
  it("surfaces a named error when the summaries list fails", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: { code: "STORAGE_ERROR", message: "postgres unavailable" },
      })
    );
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("header-search-error")).toBeTruthy();
    expect(screen.getByText(/STORAGE_ERROR/)).toBeTruthy();
  });

  it("renders a typeahead input in the persistent header", async () => {
    mockFetch(() => jsonResponse(200, summariesResponse()));
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    expect(input.getAttribute("placeholder")).toBeTruthy();
    expect(input.getAttribute("type")).toBe("search");
  });

  it("shows matching 资料 row when typing a source_ref substring", async () => {
    mockFetch(() => jsonResponse(200, summariesResponse()));
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    await userEvent.type(input, "docs/fi");
    const option = await screen.findByTestId(
      `header-search-option-${DOC_A_ID}`
    );
    // source_ref substring matched
    expect(option.textContent).toContain("docs/first.md");
  });

  it("matches title substring and shows the matching row", async () => {
    mockFetch(() => jsonResponse(200, summariesResponse()));
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    await userEvent.type(input, "第二条");
    const option = await screen.findByTestId(
      `header-search-option-${DOC_B_ID}`
    );
    expect(option.textContent).toContain("docs/second.md");
  });

  it("matches empty-title rows by source_ref substring", async () => {
    mockFetch(() => jsonResponse(200, summariesResponse()));
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    await userEvent.type(input, "no-title");
    const option = await screen.findByTestId(
      `header-search-option-${DOC_C_ID}`
    );
    expect(option.textContent).toContain("docs/no-title.md");
  });

  it("excludes invalidated docs (valid_until !== null) from suggestions", async () => {
    mockFetch(() => jsonResponse(200, summariesResponse()));
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    await userEvent.type(input, "已失效");
    // 'closed.md' is invalidated; the title match must NOT surface it.
    await waitFor(() => {
      expect(
        screen.queryByTestId(`header-search-option-${DOC_D_ID}`)
      ).toBeNull();
    });
  });

  it("navigates to /sources/:id when an option is selected", async () => {
    mockFetch((url) => {
      if (url.startsWith("/api/sources?")) {
        return jsonResponse(200, summariesResponse());
      }
      if (url === `/api/sources/${DOC_A_ID}`) {
        return jsonResponse(200, {
          id: DOC_A_ID,
          source_ref: "docs/first.md",
          title: "第一条",
          content: "the body of doc A",
          created_at: "2026-01-01T00:00:00.000Z",
          valid_until: null,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    await userEvent.type(input, "docs/fi");
    const option = await screen.findByTestId(
      `header-search-option-${DOC_A_ID}`
    );
    await userEvent.click(option);
    // The dropdown closes on selection. Since this test renders Chrome
    // in isolation (no detail route registered), we pin navigation by
    // observing the dropdown dismissal — the option's onMouseDown handler
    // commits and calls useNavigate(), which would route to
    // /sources/:id in the full App. The next test wires the full App to
    // assert the detail body actually renders.
    await waitFor(() => {
      expect(
        screen.queryByTestId(`header-search-option-${DOC_A_ID}`)
      ).toBeNull();
    });
  });

  it("opens the 资料 detail page when an option is selected in the full App", async () => {
    mockFetch((url) => {
      if (url.startsWith("/api/sources?")) {
        return jsonResponse(200, summariesResponse());
      }
      if (url === `/api/sources/${DOC_A_ID}`) {
        return jsonResponse(200, {
          id: DOC_A_ID,
          source_ref: "docs/first.md",
          title: "第一条",
          content: "the body of doc A",
          created_at: "2026-01-01T00:00:00.000Z",
          valid_until: null,
        });
      }
      if (url.startsWith("/api/stats")) {
        return jsonResponse(200, {
          chunks: 0,
          entities: 0,
          invalidations: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    await userEvent.type(input, "docs/fi");
    const option = await screen.findByTestId(
      `header-search-option-${DOC_A_ID}`
    );
    await userEvent.click(option);
    // The header is persistent across routes (per spec) — the input
    // stays mounted AND the detail page body renders below it.
    expect(screen.getByTestId("header-search-input")).toBeTruthy();
    expect(await screen.findByTestId("source-body")).toBeTruthy();
    expect(screen.getByText("the body of doc A")).toBeTruthy();
  });

  it("only fetches the /api/sources summaries — never /api/query", async () => {
    const seenUrls: string[] = [];
    mockFetch((url) => {
      seenUrls.push(url);
      return jsonResponse(200, summariesResponse());
    });
    render(
      <MemoryRouter>
        <Chrome />
      </MemoryRouter>
    );
    const input = await screen.findByTestId("header-search-input");
    // Use the native value setter so React's onChange fires once with the
    // full string — `userEvent.type` with non-ASCII text can race with the
    // 150ms debounce here.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(input, "第二条");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      await userEvent.type(input, "第二条");
    }
    await screen.findByTestId(`header-search-option-${DOC_B_ID}`);
    // No retrieve-touched endpoint may be called.
    expect(seenUrls.some((u) => u.includes("/api/query"))).toBe(false);
    // And the only fetch the header search issues is the summaries list.
    const summariesCalls = seenUrls.filter((u) => u.startsWith("/api/sources"));
    expect(summariesCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of summariesCalls) {
      expect(call).not.toMatch(/^[^?]*\/api\/sources\/[^?]+/); // detail ids must not appear
      const limitMatch = call.match(/[?&]limit=(\d+)/);
      expect(limitMatch).not.toBeNull();
      expect(Number(limitMatch![1])).toBeLessThanOrEqual(100);
      expect(call).not.toContain("limit=200");
    }
  });
});
