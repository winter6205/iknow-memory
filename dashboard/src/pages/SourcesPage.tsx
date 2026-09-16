import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchJson,
  isEmptyPage,
  SOURCE_DOC_STATUS,
  SOURCE_STATUS_LABEL,
  type PageBody,
  type SourceSummary,
} from "../api";
import {
  BOARD_CODE,
  EmptyCopy,
  ErrorCopy,
  PageChrome,
  type PageState,
} from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; data: PageBody<SourceSummary> }
  | { state: "error"; code: string; message: string };

const PAGE_SIZE = 20;

export function SourcesPage() {
  const [view, setView] = useState<View>({ state: "loading" });

  const load = useCallback((offset = 0) => {
    setView({ state: "loading" });
    void fetchJson<PageBody<SourceSummary>>(
      `/api/sources?limit=${PAGE_SIZE}&offset=${offset}`
    ).then((res) => {
      if (!res.ok) {
        setView({
          state: "error",
          code: res.error.code,
          message: res.error.message,
        });
        return;
      }
      setView(
        isEmptyPage(res.data)
          ? { state: "empty" }
          : { state: "ready", data: res.data }
      );
    });
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  const state: PageState = view.state;

  return (
    <PageChrome title="资料" state={state}>
      {view.state === "empty" ? (
        <EmptyCopy code={BOARD_CODE.EMPTY_LEDGER} />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy
          code={view.code}
          message={view.message}
          onRetry={() => load(0)}
        />
      ) : null}
      {view.state === "ready" ? (
        <SourcesTable view={view.data} load={load} />
      ) : null}
    </PageChrome>
  );
}

type SourcesTableProps = {
  view: PageBody<SourceSummary>;
  load: (offset: number) => void;
};

/**
 * Status → ink class, keyed off `SOURCE_DOC_STATUS` like `SOURCE_STATUS_LABEL`
 * so the vocabulary has one spelling in the SPA as well as on the server.
 */
const STATUS_CLASS: Record<SourceSummary["status"], string> = {
  [SOURCE_DOC_STATUS.READY]: "text-ink",
  [SOURCE_DOC_STATUS.FAILED]: "text-[var(--danger)]",
  [SOURCE_DOC_STATUS.IN_PROGRESS]: "text-[var(--text-tertiary)]",
};

/**
 * 状态 chip (corpus-ready retrieve T3). The status is read straight off the
 * persisted field; the page never infers it from `valid_until`.
 */
function StatusChip({ doc }: { doc: SourceSummary }) {
  const label = SOURCE_STATUS_LABEL[doc.status] ?? doc.status;
  return (
    <span
      data-testid={`source-row-status-${doc.id}`}
      className={`rounded border border-line px-2 py-0.5 ${STATUS_CLASS[doc.status] ?? ""}`}
      title={doc.failure_code ?? undefined}
    >
      {label}
    </span>
  );
}

function SourcesTable({ view, load }: SourcesTableProps) {
  const start = view.offset + 1;
  const end = view.offset + view.items.length;
  const total = view.total;
  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-[var(--text-tertiary)]">
        资料列表 ({start}–{end} / {total})
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left font-mono text-xs text-[var(--text-tertiary)]">
            <th className="py-2 pr-4">标题</th>
            <th className="py-2 pr-4">资料集合</th>
            <th className="py-2 pr-4">状态</th>
            <th className="py-2 pr-4">成功块数</th>
            <th className="py-2 pr-4">创建时间</th>
            <th className="py-2 pr-4">id</th>
            <th className="py-2 pr-4">source_ref</th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((doc) => {
            const titleLabel = doc.title ?? doc.source_ref;
            const invalidated = doc.valid_until !== null;
            return (
              <tr
                key={doc.id}
                className="border-b border-line align-top"
                data-testid={`source-row-${doc.id}`}
              >
                <td className="py-3 pr-4">
                  <Link
                    to={`/sources/${doc.id}`}
                    className="text-ink no-underline"
                  >
                    {titleLabel}
                  </Link>
                </td>
                <td
                  className="py-3 pr-4 font-mono text-xs"
                  data-testid={`source-row-collection-${doc.id}`}
                >
                  {doc.collection}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">
                  <StatusChip doc={doc} />
                  {invalidated ? (
                    <span
                      data-testid="source-row-state-invalidated"
                      className="ml-2 rounded border border-line px-2 py-0.5 text-[var(--text-tertiary)]"
                    >
                      失效 · {doc.valid_until}
                    </span>
                  ) : null}
                  {doc.failure_code === null ? null : (
                    <span
                      data-testid={`source-row-failure-${doc.id}`}
                      className="ml-2 rounded border border-line px-2 py-0.5 text-[var(--danger)]"
                    >
                      {doc.failure_code}
                    </span>
                  )}
                </td>
                <td
                  className="py-3 pr-4 font-mono text-xs"
                  data-testid={`source-row-count-${doc.id}`}
                >
                  {doc.chunk_count}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">
                  {doc.created_at}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">{doc.id}</td>
                <td className="py-3 pr-4 font-mono text-xs">
                  <Link
                    to={`/sources/${doc.id}`}
                    className="text-accent no-underline"
                  >
                    {doc.source_ref}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {total > PAGE_SIZE ? (
        <div className="flex items-center gap-2 font-mono text-xs">
          <button
            type="button"
            disabled={view.offset === 0}
            onClick={() => load(Math.max(0, view.offset - PAGE_SIZE))}
            className="rounded-md border border-line px-2 py-1 disabled:opacity-40"
          >
            ‹ 上一页
          </button>
          <span className="text-[var(--text-tertiary)]">
            {Math.floor(view.offset / PAGE_SIZE) + 1} /{" "}
            {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <button
            type="button"
            disabled={end >= total}
            onClick={() => load(view.offset + PAGE_SIZE)}
            className="rounded-md border border-line px-2 py-1 disabled:opacity-40"
          >
            下一页 ›
          </button>
        </div>
      ) : null}
    </div>
  );
}
