/**
 * T6 SPA — 资料 list + detail + 404/error + retry. Three board states are
 * pinned here for the 资料 surface; the graph-lag case for the graph
 * surface is pinned in graph.test.tsx below.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ImportPage } from "./pages/ImportPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SourceDetailPage } from "./pages/SourceDetailPage";

const DOC_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DOC_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** The four 资料页 fields (corpus-ready retrieve T3) as /api/sources sends them. */
function pageFields(
  status: string,
  chunkCount: number,
  failureCode: string | null = null
) {
  return {
    collection: "默认资料集合",
    status,
    failure_code: failureCode,
    chunk_count: chunkCount,
  };
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function mockFetch(handler: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      return handler(requestUrl(input));
    })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SourcesPage", () => {
  it("shows the empty-ledger shell when /api/sources returns an empty page", async () => {
    mockFetch(() =>
      jsonResponse(200, { items: [], total: 0, limit: 20, offset: 0 })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.queryByTestId("page-state-error")).toBeNull();
    expect(screen.getByTestId("board-code").textContent).toBe("EMPTY_LEDGER");
    expect(screen.queryByText(/账本为空/)).toBeNull();
    expect(screen.queryByTestId("source-ingest")).toBeNull();
  });

  it("does not host the ingest form on the 资料 list", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/first.md",
            title: "第一条",
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.queryByTestId("source-ingest")).toBeNull();
  });

  it("shows error + retry when /api/sources returns STORAGE_ERROR", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: { code: "STORAGE_ERROR", message: "postgres unavailable" },
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/STORAGE_ERROR/)).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });

  it("retries GET /api/sources when the operator clicks 重试", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(503, {
          error: { code: "STORAGE_ERROR", message: "boom" },
        });
      }
      return jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/first.md",
            title: "第一条",
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      });
    });
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-error");
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => {
      expect(screen.getByTestId("page-state-ready")).toBeTruthy();
    });
    expect(calls).toBe(2);
  });

  it("displays a 资料 row with empty title as source_ref", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/no-title.md",
            title: null,
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    // Empty title displays source_ref, not blank — both the source_ref
    // column and the title column fall back to source_ref.
    expect(
      screen.getAllByText("docs/no-title.md").length
    ).toBeGreaterThanOrEqual(2);
    const links = screen.getAllByRole("link", { name: /docs\/no-title\.md/ });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(`/sources/${DOC_A_ID}`);
    }
  });

  it("renders list as a recognisable operator-board table, not a stats monitor", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/first.md",
            title: "第一条",
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
            ...pageFields("ready", 3),
          },
          {
            id: DOC_B_ID,
            source_ref: "docs/closed.md",
            title: "已失效",
            created_at: "2026-01-02T00:00:00.000Z",
            valid_until: "2026-06-01T00:00:00.000Z",
            ...pageFields("failed", 0, "CONTENT_TOO_LARGE"),
          },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    // Human columns first: 标题 / 状态 / 创建时间, then id / source_ref.
    // columns, with each row linking to the detail route.
    const rowA = screen.getByRole("link", { name: /docs\/first\.md/ });
    expect(rowA.getAttribute("href")).toBe(`/sources/${DOC_A_ID}`);
    expect(screen.getByText(DOC_A_ID)).toBeTruthy();
    expect(screen.getByText(DOC_B_ID)).toBeTruthy();
    // Invalidation state surfaces as a distinct visual chip.
    expect(screen.getByTestId("source-row-state-invalidated")).toBeTruthy();
  });

  it("shows the four 资料页 fields per row: 集合 / 身份 / 状态 / 成功块数", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/first.md",
            title: "第一条",
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
            ...pageFields("ready", 3),
          },
          {
            id: DOC_B_ID,
            source_ref: "docs/second.md",
            title: null,
            created_at: "2026-01-02T00:00:00.000Z",
            valid_until: null,
            ...pageFields("failed", 0, "CONTENT_TOO_LARGE"),
          },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    // (1) collection name is visible once per row, in its own cell.
    expect(
      screen.getByTestId(`source-row-collection-${DOC_A_ID}`).textContent
    ).toBe("默认资料集合");
    expect(
      screen.getByTestId(`source-row-collection-${DOC_B_ID}`).textContent
    ).toBe("默认资料集合");
    // (2) 资料 identity: title-or-source_ref + the id column.
    expect(screen.getByText("第一条")).toBeTruthy();
    expect(screen.getAllByText("docs/second.md").length).toBeGreaterThanOrEqual(
      1
    );
    expect(screen.getByText(DOC_A_ID)).toBeTruthy();
    expect(screen.getByText(DOC_B_ID)).toBeTruthy();
    // (3) status: 就绪 and 失败 are distinct, named chips.
    expect(
      screen.getByTestId(`source-row-status-${DOC_A_ID}`).textContent
    ).toBe("就绪");
    expect(
      screen.getByTestId(`source-row-status-${DOC_B_ID}`).textContent
    ).toBe("失败");
    // 失败 carries its stable code so the operator can act on it.
    expect(
      screen.getByTestId(`source-row-failure-${DOC_B_ID}`).textContent
    ).toBe("CONTENT_TOO_LARGE");
    expect(screen.queryByTestId(`source-row-failure-${DOC_A_ID}`)).toBeNull();
    // (4) successful chunk count, per row.
    expect(screen.getByTestId(`source-row-count-${DOC_A_ID}`).textContent).toBe(
      "3"
    );
    expect(screen.getByTestId(`source-row-count-${DOC_B_ID}`).textContent).toBe(
      "0"
    );
  });

  it("shows 进行中 for a 资料 whose push has not landed a chunk yet", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/fresh.md",
            title: null,
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
            ...pageFields("in_progress", 0),
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(
      screen.getByTestId(`source-row-status-${DOC_A_ID}`).textContent
    ).toBe("进行中");
    expect(screen.getByTestId(`source-row-count-${DOC_A_ID}`).textContent).toBe(
      "0"
    );
  });

  it("keeps the 资料 LIST read-only: no 中台 maintenance write buttons (SC7)", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: DOC_A_ID,
            source_ref: "docs/first.md",
            title: "第一条",
            created_at: "2026-01-01T00:00:00.000Z",
            valid_until: null,
            ...pageFields("ready", 1),
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      })
    );
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("source-writes")).toBeNull();
    expect(screen.queryByTestId("source-ingest")).toBeNull();
  });
});

describe("ImportPage", () => {
  it("hosts ImportView-shaped ingest (source_ref + body + ingest)", () => {
    render(
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>
    );
    expect(screen.getByTestId("source-ingest")).toBeTruthy();
    expect(screen.getByLabelText("source_ref")).toBeTruthy();
    expect(screen.getByLabelText("资料正文")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ingest/ })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("SourceDetailPage", () => {
  it("shows the four 资料页 fields on the detail chrome", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: DOC_A_ID,
        source_ref: "docs/first.md",
        title: "第一条",
        content: "body",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
        ...pageFields("ready", 4),
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByTestId("source-detail-collection").textContent).toBe(
      "默认资料集合"
    );
    expect(screen.getByTestId("source-detail-status").textContent).toBe("就绪");
    expect(screen.getByTestId("source-detail-count").textContent).toContain(
      "4"
    );
    // 资料 identity: the id the page was opened with.
    expect(screen.getByTestId("source-detail-identity").textContent).toContain(
      DOC_A_ID
    );
  });

  it("shows 失败 with its stable code for a failed push", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: DOC_A_ID,
        source_ref: "docs/first.md",
        title: "第一条",
        content: "body",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
        ...pageFields("failed", 0, "CONTENT_TOO_LARGE"),
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByTestId("source-detail-status").textContent).toBe("失败");
    expect(screen.getByTestId("source-detail-failure-code").textContent).toBe(
      "CONTENT_TOO_LARGE"
    );
    expect(screen.getByTestId("source-detail-count").textContent).toBe("0");
  });

  it("shows the full 资料 body and renders title-or-source_ref fallback", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: DOC_A_ID,
        source_ref: "docs/first.md",
        title: "第一条",
        content: "the body — full 资料 body from /api/sources/:id",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
        ...pageFields("ready", 1),
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("第一条")).toBeTruthy();
    expect(
      screen.getByText(/the body — full 资料 body from \/api\/sources\/:id/)
    ).toBeTruthy();
  });

  it("renders source_ref as title when title is null", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: DOC_A_ID,
        source_ref: "docs/no-title.md",
        title: null,
        content: "body",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("docs/no-title.md")).toBeTruthy();
  });

  it("shows named miss + retry when /api/sources/:id is NOT_FOUND", async () => {
    mockFetch(() =>
      jsonResponse(404, {
        error: { code: "NOT_FOUND", message: "source document not found" },
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/NOT_FOUND/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });

  it("exposes thin write controls on 资料 chrome", async () => {
    mockFetch((url) => {
      if (url.includes(`/api/sources/${DOC_A_ID}`)) {
        return jsonResponse(200, {
          id: DOC_A_ID,
          source_ref: "docs/first.md",
          title: "第一条",
          content: "body",
          created_at: "2026-01-01T00:00:00.000Z",
          valid_until: null,
        });
      }
      if (url.includes("/api/writes/")) {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("source-writes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "extract" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "invalidate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "graph:backfill" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "graph:drain" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "extract" }));
    expect(await screen.findByTestId("source-writes-notice")).toBeTruthy();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls as Array<[RequestInfo, RequestInit?]>;
    const extract = calls.find(([input]) =>
      requestUrl(input).includes("/api/writes/extract")
    );
    expect(extract).toBeTruthy();
    expect(extract?.[1]?.method).toBe("POST");
  });

  it("shows error + retry on STORAGE_ERROR, not an empty chrome", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: { code: "STORAGE_ERROR", message: "boom" },
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/STORAGE_ERROR/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });

  it("pins PageDetail layout: primary card, page-content, action-row after body, empty 提及", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: DOC_A_ID,
        source_ref: "docs/first.md",
        title: "第一条",
        content: "the body — full 资料 body from /api/sources/:id",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← 资料" })).toBeTruthy();

    const title = screen.getByRole("heading", { name: "第一条" });
    const pageContent = screen.getByTestId("source-page-content");
    const actionRow = screen.getByTestId("source-action-row");
    expect(title.className).toMatch(/font-display/);
    expect(pageContent.className).toMatch(/page-content/);
    expect(actionRow.className).toMatch(/action-row/);
    expect(pageContent.closest(".card")).toBeTruthy();
    expect(pageContent.textContent).toContain(
      "the body — full 资料 body from /api/sources/:id"
    );
    expect(screen.getByText("valid")).toBeTruthy();
    expect(screen.getByText(/创建于/)).toBeTruthy();

    const following = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(title.compareDocumentPosition(pageContent) & following).toBeTruthy();
    expect(
      pageContent.compareDocumentPosition(actionRow) & following
    ).toBeTruthy();
    expect(
      actionRow.querySelector('[data-testid="source-writes"]')
    ).toBeTruthy();

    expect(screen.getByText(/提及\s*\(0\)/)).toBeTruthy();
    expect(screen.getByText("暂无提及")).toBeTruthy();
    expect(screen.queryByText(/出链/)).toBeNull();
    expect(screen.queryByText(/入链/)).toBeNull();
    expect(screen.queryByText("标签")).toBeNull();
    expect(screen.queryByText("时间线")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows muted 无内容 when 资料 body is empty", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        id: DOC_A_ID,
        source_ref: "docs/empty.md",
        title: "空资料",
        content: "",
        created_at: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      })
    );
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("无内容")).toBeTruthy();
    expect(screen.getByTestId("source-action-row")).toBeTruthy();
  });

  it("does not invent 资料 inbound or fetch /links; 提及 stays empty", async () => {
    mockFetch((url) => {
      if (url.includes("/links")) {
        throw new Error(`unexpected ${url}`);
      }
      if (url.includes(`/api/sources/${DOC_A_ID}`)) {
        return jsonResponse(200, {
          id: DOC_A_ID,
          source_ref: "docs/first.md",
          title: "第一条",
          content: "body",
          created_at: "2026-01-01T00:00:00.000Z",
          valid_until: null,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter initialEntries={[`/sources/${DOC_A_ID}`]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText(/提及\s*\(0\)/)).toBeTruthy();
    expect(screen.getByText("暂无提及")).toBeTruthy();
    expect(screen.queryByText(/入链/)).toBeNull();
    expect(screen.queryByTestId("page-state-empty")).toBeNull();
  });
});
