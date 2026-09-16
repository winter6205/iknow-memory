/**
 * T8 SPA — graph node click opens an **entity** route.
 *
 * The graph surface in `pages/GraphPage` renders `VisGraph` (a
 * vis-network wrapper). T8 wires the `selectNode` event to a
 * navigation call so a single click on any node opens
 * `/browse/entities/:id` — the existing entity detail surface, not the
 * 资料 route.
 *
 * Acceptance: a `selectNode` event with one node id resolves to a
 * push to the entity route; the 资料 detail route is never opened by
 * the graph.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";

const ENT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

// Capture every Network instance the graph page constructs. The mock
// factory below pushes onto this array so the test can fire its
// `selectNode` listener synchronously.
interface CapturedNetwork {
  events: Record<string, (params: unknown) => void>;
}
const networkInstances: CapturedNetwork[] = [];

vi.mock("vis-network/standalone", () => ({
  Network: class {
    events: Record<string, (params: unknown) => void> = {};
    constructor(_el: unknown, _data: unknown, _options: unknown) {
      networkInstances.push(this);
    }
    on(event: string, cb: (params: unknown) => void): void {
      this.events[event] = cb;
    }
    fit(): void {}
    destroy(): void {}
  },
  DataSet: class {
    constructor(_items: unknown) {}
  },
}));

// Imported AFTER the mock is registered so the test sees the captured
// instance channel the mock writes into.
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  networkInstances.length = 0;
  seenPaths.clear();
});

const seenPaths = new Set<string>();

/**
 * Wrapper component that mirrors what `App.tsx` does at the router
 * boundary: read `useNavigate` and pass a node-click handler that
 * pushes the entity route. Reads `useLocation` on every render so the
 * test can assert that the navigation actually landed on the entity
 * route (the initial `/graph` boot path is excluded from the recorded
 * list).
 */
function AppWithSpy({
  children,
  pushes,
}: {
  children: ReactNode;
  pushes: string[];
}) {
  const navigate = useNavigate();
  const loc = useLocation();
  if (!seenPaths.has(loc.pathname)) {
    seenPaths.add(loc.pathname);
    if (loc.pathname !== "/graph") pushes.push(loc.pathname);
  }
  return (
    <GraphPage onSelectNode={(id) => navigate(`/browse/entities/${id}`)} />
  );
}

describe("GraphPage — graph node click opens an entity, not a 资料", () => {
  it("navigates to /browse/entities/:id when a graph node is selected", async () => {
    const pushes: string[] = [];
    mockFetch((url) => {
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, {
          nodes: [
            { id: ENT_ID, name: "Alice", type: "person" },
            { id: OTHER_ID, name: "Acme", type: "system" },
          ],
          edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
        });
      }
      if (url.startsWith("/api/sources") || url.startsWith("/api/stats")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 1,
          offset: 0,
          chunks: 0,
          entities: 0,
          invalidations: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <AppWithSpy pushes={pushes}>{null}</AppWithSpy>
      </MemoryRouter>
    );

    // Wait for the ready state to render the graph canvas. The mock
    // above captures the Network instance so the test can drive the
    // selectNode event manually.
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="graph-canvas"]')
      ).toBeTruthy();
    });
    expect(networkInstances.length).toBeGreaterThan(0);
    const selectNode = networkInstances[0]!.events["selectNode"];
    expect(selectNode).toBeDefined();

    // Fire the selectNode event with the entity id.
    selectNode!({ nodes: [ENT_ID] });

    // The navigation must have pushed the entity route — never the
    // 资料 route. The route shape mirrors the existing
    // EntityDetailPage wiring (`/browse/entities/:id`).
    await waitFor(() => {
      expect(pushes).toContain(`/browse/entities/${ENT_ID}`);
    });
    for (const nav of pushes) {
      expect(nav).not.toMatch(/^\/sources\//);
    }
  });

  it("does not navigate when no node is selected (deselect event is a no-op)", async () => {
    const pushes: string[] = [];
    mockFetch((url) => {
      if (url.startsWith("/api/graph")) {
        return jsonResponse(200, {
          nodes: [
            { id: ENT_ID, name: "Alice", type: "person" },
            { id: OTHER_ID, name: "Acme", type: "system" },
          ],
          edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
        });
      }
      if (url.startsWith("/api/sources") || url.startsWith("/api/stats")) {
        return jsonResponse(200, {
          items: [],
          total: 0,
          limit: 1,
          offset: 0,
          chunks: 0,
          entities: 0,
          invalidations: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <AppWithSpy pushes={pushes}>{null}</AppWithSpy>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="graph-canvas"]')
      ).toBeTruthy();
    });
    expect(networkInstances.length).toBeGreaterThan(0);
    const selectNode = networkInstances[0]!.events["selectNode"];
    expect(selectNode).toBeDefined();

    // Empty selection list — deselect. The handler must not navigate.
    selectNode!({ nodes: [] });

    // Give React a tick to flush any pending renders.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pushes).toEqual([]);
  });

  it("does not navigate on preview node click", async () => {
    const pushes: string[] = [];
    mockFetch((url) => {
      if (url.startsWith("/api/graph") || url.startsWith("/api/sources")) {
        return jsonResponse(200, {
          nodes: [],
          edges: [],
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
        <AppWithSpy pushes={pushes}>{null}</AppWithSpy>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="graph-canvas"]')
      ).toBeTruthy();
    });
    expect(networkInstances.length).toBeGreaterThan(0);
    expect(networkInstances[0]!.events["selectNode"]).toBeUndefined();
    expect(pushes).toEqual([]);
  });
});
