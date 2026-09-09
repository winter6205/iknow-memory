/**
 * T6 SPA pages — empty ledger vs capability error, plus query degraded.
 * Fixtures copy T2–T4 handler JSON (tests/dashboard/*.test.ts). No invented contract.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { BrowsePage } from "./pages/BrowsePage";
import { ChunkDetailPage } from "./pages/ChunkDetailPage";
import { EntityDetailPage } from "./pages/EntityDetailPage";
import { GraphPage } from "./pages/GraphPage";
import { NeighborhoodPage } from "./pages/NeighborhoodPage";
import { QueryPage } from "./pages/QueryPage";
import { StatsPage } from "./pages/StatsPage";
import { TimelinePage } from "./pages/TimelinePage";

const ENT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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

describe("StatsPage", () => {
  it("shows empty ledger chrome when /api/stats returns zeros", async () => {
    mockFetch(() =>
      jsonResponse(200, { chunks: 0, entities: 0, invalidations: 0 })
    );
    render(<StatsPage />);
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("shows error chrome, not empty, when /api/stats returns STORAGE_ERROR", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: { code: "STORAGE_ERROR", message: "postgres unavailable" },
      })
    );
    render(<StatsPage />);
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/STORAGE_ERROR/)).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });

  it("shows counts when the ledger has data", async () => {
    mockFetch(() =>
      jsonResponse(200, { chunks: 2, entities: 0, invalidations: 0 })
    );
    render(<StatsPage />);
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});

describe("QueryPage", () => {
  it("shows empty hits for 200 { chunks: [] }", async () => {
    mockFetch((url) => {
      expect(url).toContain("/api/query?q=");
      return jsonResponse(200, { chunks: [] });
    });
    render(<QueryPage />);
    await userEvent.type(screen.getByRole("searchbox"), "nothing matches");
    await userEvent.click(screen.getByRole("button", { name: /检索/ }));
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("degraded-banner")).toBeNull();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("shows error chrome for 503 RETRIEVAL_FAILED, not an empty hit list", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: { code: "RETRIEVAL_FAILED", message: "vector arm exploded" },
      })
    );
    render(<QueryPage />);
    await userEvent.type(screen.getByRole("searchbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /检索/ }));
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/RETRIEVAL_FAILED/)).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });

  it("surfaces degraded when the retrieve envelope sets degraded:true", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        chunks: [
          {
            id: UUID_A,
            content: "alpha beta",
            source_ref: "test://query-a",
            valid_window: ["2024-01-01T00:00:00.000Z", null],
            score: 0.9,
          },
        ],
        degraded: true,
        degraded_reasons: ["graph_arm_failed"],
      })
    );
    render(<QueryPage />);
    await userEvent.type(screen.getByRole("searchbox"), "alpha");
    await userEvent.click(screen.getByRole("button", { name: /检索/ }));
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByTestId("degraded-banner")).toBeTruthy();
    expect(screen.getByText(/graph_arm_failed/)).toBeTruthy();
  });

  it("surfaces degraded on empty hits when the envelope sets degraded:true", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        chunks: [],
        degraded: true,
        degraded_reasons: ["graph_arm_failed"],
      })
    );
    render(<QueryPage />);
    await userEvent.type(screen.getByRole("searchbox"), "nothing");
    await userEvent.click(screen.getByRole("button", { name: /检索/ }));
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.getByTestId("degraded-banner")).toBeTruthy();
    expect(screen.getByText(/graph_arm_failed/)).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });
});

describe("BrowsePage", () => {
  it("shows empty when chunk and entity pages are empty ledgers", async () => {
    mockFetch((url) => {
      if (url.includes("/api/chunks")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 20,
          offset: 0,
        });
      }
      if (url.includes("/api/entities")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 20,
          offset: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("shows error when /api/chunks returns STORAGE_ERROR", async () => {
    mockFetch((url) => {
      if (url.includes("/api/chunks")) {
        return jsonResponse(503, {
          error: { code: "STORAGE_ERROR", message: "boom" },
        });
      }
      return jsonResponse(200, {
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      });
    });
    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });

  it("links list rows to chunk and entity detail routes", async () => {
    mockFetch((url) => {
      if (url.includes("/api/chunks")) {
        return jsonResponse(200, {
          items: [{ id: UUID_A, content: "alpha", source_ref: "test://a" }],
          total: 1,
          limit: 20,
          offset: 0,
        });
      }
      if (url.includes("/api/entities")) {
        return jsonResponse(200, {
          items: [{ id: ENT_ID, canonical_name: "Alice", type: "person" }],
          total: 1,
          limit: 20,
          offset: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /alpha/ }).getAttribute("href")
    ).toBe(`/browse/chunks/${UUID_A}`);
    expect(
      screen.getByRole("link", { name: /Alice/ }).getAttribute("href")
    ).toBe(`/browse/entities/${ENT_ID}`);
  });
});

describe("ChunkDetailPage", () => {
  it("shows empty when GET /api/chunks/:id is NOT_FOUND", async () => {
    mockFetch((url) => {
      expect(url).toBe(`/api/chunks/${UUID_A}`);
      return jsonResponse(404, {
        error: { code: "NOT_FOUND", message: "chunk not found" },
      });
    });
    render(
      <MemoryRouter initialEntries={[`/browse/chunks/${UUID_A}`]}>
        <Routes>
          <Route path="/browse/chunks/:id" element={<ChunkDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("shows chunk fields from GET /api/chunks/:id", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: UUID_A,
        content: "alpha",
        source_ref: "test://a",
        valid_from: "2024-01-01T00:00:00.000Z",
        valid_until: null,
        metadata: {},
      })
    );
    render(
      <MemoryRouter initialEntries={[`/browse/chunks/${UUID_A}`]}>
        <Routes>
          <Route path="/browse/chunks/:id" element={<ChunkDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("test://a")).toBeTruthy();
  });
});

describe("EntityDetailPage", () => {
  it("shows empty when GET /api/entities/:id is NOT_FOUND", async () => {
    mockFetch((url) => {
      expect(url).toBe(`/api/entities/${ENT_ID}`);
      return jsonResponse(404, {
        error: { code: "NOT_FOUND", message: "entity not found" },
      });
    });
    render(
      <MemoryRouter initialEntries={[`/browse/entities/${ENT_ID}`]}>
        <Routes>
          <Route path="/browse/entities/:id" element={<EntityDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("links to the neighborhood page from entity detail", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: ENT_ID,
        canonical_name: "Alice",
        type: "person",
        retired: false,
        aliases: [],
      })
    );
    render(
      <MemoryRouter initialEntries={[`/browse/entities/${ENT_ID}`]}>
        <Routes>
          <Route path="/browse/entities/:id" element={<EntityDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /邻域/ }).getAttribute("href")
    ).toBe(`/browse/entities/${ENT_ID}/neighborhood`);
  });
});

describe("NeighborhoodPage", () => {
  it("shows empty when GET backlinks returns an empty inbound list", async () => {
    mockFetch((url) => {
      expect(url).toBe(`/api/entities/${ENT_ID}/backlinks`);
      return jsonResponse(200, {
        entity: { id: ENT_ID, name: "Alice", type: "person" },
        inbound: [],
      });
    });
    render(
      <MemoryRouter
        initialEntries={[`/browse/entities/${ENT_ID}/neighborhood`]}
      >
        <Routes>
          <Route
            path="/browse/entities/:id/neighborhood"
            element={<NeighborhoodPage />}
          />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("shows error + retry when Neo4j is missing, not empty chrome", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: {
          code: "NEO4J_UNAVAILABLE",
          message: "Neo4j sidecar is not configured",
        },
      })
    );
    render(
      <MemoryRouter
        initialEntries={[`/browse/entities/${ENT_ID}/neighborhood`]}
      >
        <Routes>
          <Route
            path="/browse/entities/:id/neighborhood"
            element={<NeighborhoodPage />}
          />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/NEO4J_UNAVAILABLE/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });

  it("retries GET backlinks when the operator clicks 重试", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(503, {
          error: {
            code: "NEO4J_UNAVAILABLE",
            message: "Neo4j sidecar is not configured",
          },
        });
      }
      return jsonResponse(200, {
        entity: { id: ENT_ID, name: "Alice", type: "person" },
        inbound: [{ from: OTHER_ID, to: ENT_ID, type: "delegates_to" }],
      });
    });
    render(
      <MemoryRouter
        initialEntries={[`/browse/entities/${ENT_ID}/neighborhood`]}
      >
        <Routes>
          <Route
            path="/browse/entities/:id/neighborhood"
            element={<NeighborhoodPage />}
          />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-error");
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => {
      expect(screen.getByTestId("page-state-ready")).toBeTruthy();
    });
    expect(calls).toBe(2);
    expect(screen.getByText(/delegates_to/)).toBeTruthy();
  });
});

describe("App browse detail routes", () => {
  it("renders chunk detail from /browse/chunks/:id", async () => {
    mockFetch((url) => {
      if (url === `/api/chunks/${UUID_A}`) {
        return jsonResponse(200, {
          id: UUID_A,
          content: "alpha",
          source_ref: "test://a",
          valid_from: "2024-01-01T00:00:00.000Z",
          valid_until: null,
          metadata: {},
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={[`/browse/chunks/${UUID_A}`]}>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
  });
});

describe("TimelinePage", () => {
  it("shows empty when /api/timeline returns an empty page", async () => {
    mockFetch(() =>
      jsonResponse(200, { items: [], total: 0, limit: 20, offset: 0 })
    );
    render(<TimelinePage />);
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("shows error when /api/timeline returns STORAGE_ERROR", async () => {
    mockFetch(() =>
      jsonResponse(503, { error: { code: "STORAGE_ERROR", message: "boom" } })
    );
    render(<TimelinePage />);
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });
});

describe("GraphPage", () => {
  it("shows error + retry when Neo4j is missing, not empty-graph chrome", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: {
          code: "NEO4J_UNAVAILABLE",
          message: "Neo4j sidecar is not configured",
        },
      })
    );
    render(<GraphPage />);
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/NEO4J_UNAVAILABLE/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
  });

  it("shows empty-projection chrome only for 200 { nodes: [], edges: [] }", async () => {
    mockFetch(() => jsonResponse(200, { nodes: [], edges: [] }));
    render(<GraphPage />);
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("retries GET /api/graph when the operator clicks 重试", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(503, {
          error: {
            code: "NEO4J_UNAVAILABLE",
            message: "Neo4j sidecar is not configured",
          },
        });
      }
      return jsonResponse(200, {
        nodes: [
          { id: ENT_ID, name: "Alice", type: "person" },
          { id: OTHER_ID, name: "Acme", type: "system" },
        ],
        edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
      });
    });
    render(<GraphPage />);
    await screen.findByTestId("page-state-error");
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => {
      expect(screen.getByTestId("page-state-ready")).toBeTruthy();
    });
    expect(calls).toBe(2);
  });
});
