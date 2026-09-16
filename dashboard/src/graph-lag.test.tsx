/**
 * T6 SPA — graph-lag board state (operator-board prototype keeps the shell
 * visible, distinguishes "projection empty while ledger has 资料" from
 * "ledger is empty"). The graph surface consumes stats count and graph
 * projection simultaneously; the dashboard pin here reads both.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const networkFits: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("vis-network/standalone", () => ({
  Network: class {
    fit = vi.fn();
    destroy() {}
    constructor() {
      networkFits.push(this.fit);
    }
  },
  DataSet: class {
    constructor(_items: unknown) {}
  },
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { GraphPage } from "./pages/GraphPage";

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
  networkFits.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GraphPage — graph-lag distinction", () => {
  it("shows graph-lag (NOT empty) when projection is empty but ledger has 资料", async () => {
    mockFetch((url) => {
      // Empty graph projection.
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, { nodes: [], edges: [] });
      }
      if (url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          items: [{ id: "s1" }],
          total: 1,
          limit: 1,
          offset: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("page-state-graph-lag")).toBeTruthy();
    });
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
    expect(screen.getByText("GRAPH_LAG")).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });

  it("still shows the empty shell when both projection and ledger are empty", async () => {
    mockFetch((url) => {
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, { nodes: [], edges: [] });
      }
      if (url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 1,
          offset: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-graph-lag")).toBeNull();
    expect(screen.getByText("EMPTY_GRAPH")).toBeTruthy();
  });

  it("shows ready chrome when projection has nodes, ignoring stats", async () => {
    mockFetch((url) => {
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, {
          nodes: [{ id: "n1", name: "Alice", type: "person" }],
          edges: [],
        });
      }
      // We may still hit stats (some pages do), but here GraphPage itself
      // only fetches graph + counts, so don't trip if it doesn't.
      if (url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 1,
          offset: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByTestId("graph-hud").textContent).toMatch(
      /1 nodes · 0 edges/
    );
    expect(screen.getByText(/person \/ company/)).toBeTruthy();
    expect(screen.getByText(/project \/ doc \/ note \/ meeting/)).toBeTruthy();
    const fit = screen.getByRole("button", { name: "归位" });
    expect(fit).toBeTruthy();
    await userEvent.click(fit);
    expect(networkFits.length).toBeGreaterThan(0);
    expect(networkFits[0]).toHaveBeenCalled();
  });

  it("shows named error (NOT empty) when 资料 count fetch fails while projection is empty", async () => {
    mockFetch((url) => {
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, { nodes: [], edges: [] });
      }
      if (url.startsWith("/api/sources")) {
        return jsonResponse(503, {
          error: { code: "STORAGE_ERROR", message: "postgres down" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/STORAGE_ERROR/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
    expect(screen.queryByTestId("page-state-graph-lag")).toBeNull();
  });

  it("preview=1 shows PREVIEW_GRAPH caption and ready canvas even if /api/graph is empty", async () => {
    mockFetch((url) => {
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, { nodes: [], edges: [] });
      }
      if (url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 1,
          offset: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/graph?preview=1"]}>
        <GraphPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText(/PREVIEW_GRAPH/)).toBeTruthy();
    expect(screen.getByTestId("graph-canvas")).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
    expect(screen.queryByTestId("page-state-graph-lag")).toBeNull();
  });
});
