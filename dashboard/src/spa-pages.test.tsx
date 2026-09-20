/**
 * T6 SPA pages — empty ledger vs capability error.
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
    expect(screen.getByTestId("board-code").textContent).toBe("EMPTY_LEDGER");
    expect(screen.queryByText(/账本为空/)).toBeNull();
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
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
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
    expect(screen.getByTestId("board-code").textContent).toBe("EMPTY_BROWSE");
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
    expect(screen.getByTestId("board-code").textContent).toBe("NOT_FOUND");
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
    expect(screen.getByTestId("board-code").textContent).toBe("NOT_FOUND");
  });

  it("links to the neighborhood page from entity detail", async () => {
    mockFetch((url) => {
      if (url === `/api/entities/${ENT_ID}/backlinks`) {
        return jsonResponse(200, {
          entity: { id: ENT_ID, name: "Alice", type: "person" },
          inbound: [],
          outbound: [],
        });
      }
      if (url === `/api/entities/${ENT_ID}`) {
        return jsonResponse(200, {
          id: ENT_ID,
          canonical_name: "Alice",
          type: "person",
          retired: false,
          aliases: [],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
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

  // Closed entity type set (entity-type-and-filter T1): the detail page must
  // render the stored type string verbatim for each of the four legal values.
  it.each(["person", "organization", "place", "event"])(
    "displays the stored entity type %s verbatim",
    async (type) => {
      mockFetch((url) => {
        if (url === `/api/entities/${ENT_ID}/backlinks`) {
          return jsonResponse(200, {
            entity: { id: ENT_ID, name: "Alice", type },
            inbound: [],
            outbound: [],
          });
        }
        return jsonResponse(200, {
          id: ENT_ID,
          canonical_name: "Alice",
          type,
          retired: false,
          aliases: [],
        });
      });
      render(
        <MemoryRouter initialEntries={[`/browse/entities/${ENT_ID}`]}>
          <Routes>
            <Route path="/browse/entities/:id" element={<EntityDetailPage />} />
          </Routes>
        </MemoryRouter>
      );
      expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
      expect(screen.getByText(type)).toBeTruthy();
    }
  );

  it("shows 出链 / 入链 cards with named neighbor links from GET backlinks", async () => {
    mockFetch((url) => {
      if (url === `/api/entities/${ENT_ID}/backlinks`) {
        return jsonResponse(200, {
          entity: { id: ENT_ID, name: "Alice", type: "person" },
          inbound: [
            {
              id: OTHER_ID,
              name: "Acme",
              type: "organization",
              relation: "delegates_to",
            },
          ],
          outbound: [
            {
              id: OTHER_ID,
              name: "Acme",
              type: "organization",
              relation: "works_for",
            },
          ],
        });
      }
      if (url === `/api/entities/${ENT_ID}`) {
        return jsonResponse(200, {
          id: ENT_ID,
          canonical_name: "Alice",
          type: "person",
          retired: false,
          aliases: [],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={[`/browse/entities/${ENT_ID}`]}>
        <Routes>
          <Route path="/browse/entities/:id" element={<EntityDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText(/出链\s*\(1\)/)).toBeTruthy();
    expect(screen.getByText(/入链\s*\(1\)/)).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Acme" });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(`/browse/entities/${OTHER_ID}`);
    expect(screen.getByText(/works_for/)).toBeTruthy();
    expect(screen.getByText(/delegates_to/)).toBeTruthy();
  });
});

describe("NeighborhoodPage", () => {
  it("shows empty when GET backlinks returns empty inbound and outbound lists", async () => {
    mockFetch((url) => {
      expect(url).toBe(`/api/entities/${ENT_ID}/backlinks`);
      return jsonResponse(200, {
        entity: { id: ENT_ID, name: "Alice", type: "person" },
        inbound: [],
        outbound: [],
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
    expect(screen.getByTestId("board-code").textContent).toBe(
      "EMPTY_NEIGHBORHOOD"
    );
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
        inbound: [
          {
            id: OTHER_ID,
            name: "Acme",
            type: "organization",
            relation: "delegates_to",
          },
        ],
        outbound: [],
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
    expect(screen.getByText(/入链/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Acme" }).getAttribute("href")
    ).toBe(`/browse/entities/${OTHER_ID}`);
  });

  it("shows 出链 section when inbound is empty and outbound is not", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        entity: { id: ENT_ID, name: "Alice", type: "person" },
        inbound: [],
        outbound: [
          {
            id: OTHER_ID,
            name: "Acme",
            type: "organization",
            relation: "works_for",
          },
        ],
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
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText(/出链/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Acme" }).getAttribute("href")
    ).toBe(`/browse/entities/${OTHER_ID}`);
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
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
      // Full <App /> mounts the persistent header whose HeaderSearch loads
      // the summaries pool once on mount.
      if (url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 200,
          offset: 0,
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

describe("App query route removal", () => {
  it("redirects /query to the stats surface and never fetches /api/query", async () => {
    const seenUrls: string[] = [];
    mockFetch((url) => {
      seenUrls.push(url);
      // Full <App /> mounts the persistent header whose HeaderSearch loads
      // the summaries pool once on mount.
      if (url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 200,
          offset: 0,
        });
      }
      if (url === "/api/stats") {
        return jsonResponse(200, {
          chunks: 0,
          entities: 0,
          invalidations: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/query"]}>
        <App />
      </MemoryRouter>
    );
    // /query must not be a route: the catch-all
    // <Route path="*" element={<Navigate to="/" replace />} /> redirects to
    // the stats surface. Re-adding a /query route would render that page
    // instead, so this assertion fails — a behavioral guard stronger than a
    // source string match (a rename cannot satisfy it).
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "统计" })).toBeTruthy();
    expect(seenUrls).toContain("/api/stats");
    expect(seenUrls.some((u) => u.includes("/api/query"))).toBe(false);
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
    expect(screen.getByTestId("board-code").textContent).toBe("EMPTY_TIMELINE");
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
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/NEO4J_UNAVAILABLE/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
  });

  it("shows empty-projection chrome only for 200 { nodes: [], edges: [] }", async () => {
    mockFetch(() => jsonResponse(200, { nodes: [], edges: [] }));
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
  });

  it("retries GET /api/graph when the operator clicks 重试", async () => {
    let calls = 0;
    mockFetch((url) => {
      calls += 1;
      if (calls === 1) {
        // GraphPage fetches /api/graph + /api/stats in parallel; the
        // graph fetch fails first, surfacing the NEO4J_UNAVAILABLE error.
        if (url.startsWith("/api/graph")) {
          return jsonResponse(503, {
            error: {
              code: "NEO4J_UNAVAILABLE",
              message: "Neo4j sidecar is not configured",
            },
          });
        }
        return jsonResponse(200, {
          chunks: 0,
          entities: 0,
          invalidations: 0,
        });
      }
      return jsonResponse(200, {
        nodes: [
          { id: ENT_ID, name: "Alice", type: "person" },
          { id: OTHER_ID, name: "Acme", type: "organization" },
        ],
        edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
      });
    });
    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphPage />
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-error");
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => {
      expect(screen.getByTestId("page-state-ready")).toBeTruthy();
    });
  });
});
