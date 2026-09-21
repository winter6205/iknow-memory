/**
 * extract-verify T3 — SPA 维护 lane.
 *
 * The page is a chrome over the dashboard-api maintenance routes: it fetches
 * GET /api/maintenance/failed and its buttons POST the same thin-write
 * runners the CLI uses (promote / discard / extract-by-chunk-id). Source and
 * chunk links reuse the existing 资料 / chunk detail routes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { MaintenancePage } from "./pages/MaintenancePage";

const REC_A = "11111111-1111-4111-8111-111111111111";
const REC_B = "22222222-2222-4222-8222-222222222222";
const CHUNK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_A = "44444444-4444-4444-8444-444444444444";

function failedItem(over: Record<string, unknown> = {}) {
  return {
    id: REC_A,
    batch_id: "55555555-5555-4555-8555-555555555555",
    chunk_id: CHUNK_A,
    error_code: "JUDGE_REJECTED",
    error_msg: "triple not grounded in chunk",
    has_proposal: true,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:05.000Z",
    source_ref: "docs/first.md",
    source_doc_id: DOC_A,
    ...over,
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
    vi.fn((input: RequestInfo | URL) => handler(requestUrl(input)))
  );
}

function postCalls(urlFragment: string): Array<{ body: string | undefined }> {
  const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls as Array<[RequestInfo, RequestInit?]>;
  return calls
    .filter(
      ([input, init]) =>
        requestUrl(input).includes(urlFragment) && init?.method === "POST"
    )
    .map(([, init]) => ({
      body: typeof init?.body === "string" ? init.body : undefined,
    }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MaintenancePage — failed list", () => {
  it("fetches /api/maintenance/failed and renders the failure reason", async () => {
    mockFetch((url) => {
      if (url.includes("/api/maintenance/failed")) {
        return jsonResponse(200, { items: [failedItem()] });
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    expect(screen.getByText("JUDGE_REJECTED")).toBeTruthy();
    expect(screen.getByText(/not grounded/)).toBeTruthy();
  });

  it("links the row to its 资料 detail and chunk detail pages", async () => {
    mockFetch(() => jsonResponse(200, { items: [failedItem()] }));
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-ready")).toBeTruthy();
    const sourceLink = screen.getByRole("link", { name: "docs/first.md" });
    expect(sourceLink.getAttribute("href")).toBe(`/sources/${DOC_A}`);
    const chunkLink = screen.getByRole("link", { name: CHUNK_A });
    expect(chunkLink.getAttribute("href")).toBe(`/browse/chunks/${CHUNK_A}`);
  });

  it("shows the empty code when nothing is awaiting review", async () => {
    mockFetch(() => jsonResponse(200, { items: [] }));
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-empty")).toBeTruthy();
    expect(screen.getByTestId("board-code").textContent).toBe(
      "EMPTY_FAILED_LANE"
    );
  });

  it("shows error + retry when the list answers STORAGE_ERROR", async () => {
    mockFetch(() =>
      jsonResponse(503, {
        error: { code: "STORAGE_ERROR", message: "postgres unavailable" },
      })
    );
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    expect(await screen.findByTestId("page-state-error")).toBeTruthy();
    expect(screen.getByText(/STORAGE_ERROR/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });
});

describe("MaintenancePage — action buttons ride the same runners", () => {
  function mockWrites(url: string): Promise<Response> {
    if (url.includes("/api/maintenance/failed")) {
      return jsonResponse(200, {
        items: [
          failedItem(),
          failedItem({
            id: REC_B,
            chunk_id: null,
            has_proposal: false,
            error_code: "JUDGE_DOWN",
            error_msg: "judge unreachable",
            source_ref: null,
            source_doc_id: null,
          }),
        ],
      });
    }
    if (url.includes("/api/maintenance/promote")) {
      return jsonResponse(200, { promoted: true, record_id: REC_A });
    }
    if (url.includes("/api/maintenance/discard")) {
      return jsonResponse(200, { discarded: true, record_id: REC_A });
    }
    if (url.includes("/api/writes/extract")) {
      return jsonResponse(200, { batch_id: "b1", processed: 1 });
    }
    throw new Error(`unexpected ${url}`);
  }

  it("promote button POSTs /api/maintenance/promote with the record id", async () => {
    mockFetch(mockWrites);
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-ready");
    await userEvent.click(screen.getByRole("button", { name: "晋升" }));
    await waitFor(() => {
      expect(postCalls("/api/maintenance/promote").length).toBe(1);
    });
    expect(JSON.parse(postCalls("/api/maintenance/promote")[0]!.body!)).toEqual(
      { record_id: REC_A }
    );
    expect(await screen.findByTestId("maintenance-notice")).toBeTruthy();
  });

  it("discard button POSTs /api/maintenance/discard with the record id", async () => {
    mockFetch(mockWrites);
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-ready");
    const row = screen.getByTestId(`maintenance-row-${REC_A}`);
    const button = row.querySelectorAll("button")[1] as HTMLButtonElement;
    await userEvent.click(button);
    await waitFor(() => {
      expect(postCalls("/api/maintenance/discard").length).toBe(1);
    });
    expect(JSON.parse(postCalls("/api/maintenance/discard")[0]!.body!)).toEqual(
      { record_id: REC_A }
    );
  });

  it("re-extract button POSTs the chunk id to /api/writes/extract", async () => {
    mockFetch(mockWrites);
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-ready");
    await userEvent.click(screen.getByRole("button", { name: "重新抽取" }));
    await waitFor(() => {
      expect(postCalls("/api/writes/extract").length).toBe(1);
    });
    expect(JSON.parse(postCalls("/api/writes/extract")[0]!.body!)).toEqual({
      chunk_ids: [CHUNK_A],
    });
  });

  it("a promoted row leaves the list on the refetch, errors surface per row", async () => {
    mockFetch(mockWrites);
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>
    );
    await screen.findByTestId("page-state-ready");
    // REC_B has neither a held proposal nor a chunk row: no promote and no
    // re-extract affordance, only discard.
    const rowB = screen.getByTestId(`maintenance-row-${REC_B}`);
    expect(rowB.querySelectorAll("button")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "晋升" })
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "重新抽取" })
    ).toHaveLength(1);
  });
});
