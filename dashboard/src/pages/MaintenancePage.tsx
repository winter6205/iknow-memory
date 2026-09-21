import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchJson,
  postJson,
  type FailedListBody,
  type FailedRecordItem,
} from "../api";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; items: FailedRecordItem[] }
  | { state: "error"; code: string; message: string };

type ActionKey = "promote" | "discard" | "re-extract";

const ACTION_LABEL: Record<ActionKey, string> = {
  promote: "晋升",
  discard: "丢弃",
  "re-extract": "重新抽取",
};

/**
 * 维护 lane (extract-verify T3) — the judge-failed extraction list with the
 * same three advances the CLI has. Every button rides a dashboard-api thin
 * write: promote / discard hit /api/maintenance/*, re-extract sends the
 * failed chunk id to /api/writes/extract — the core runners decide, this
 * page only shows.
 */
export function MaintenancePage() {
  const [view, setView] = useState<View>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const load = useCallback(() => {
    setView({ state: "loading" });
    void fetchJson<FailedListBody>("/api/maintenance/failed").then((res) => {
      if (!res.ok) {
        setView({
          state: "error",
          code: res.error.code,
          message: res.error.message,
        });
        return;
      }
      setView(
        res.data.items.length === 0
          ? { state: "empty" }
          : { state: "ready", items: res.data.items }
      );
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(item: FailedRecordItem, action: ActionKey) {
    setBusy(`${item.id}:${action}`);
    setNotice(null);
    try {
      const res =
        action === "re-extract"
          ? await postJson<unknown>("/api/writes/extract", {
              chunk_ids: [item.chunk_id],
            })
          : await postJson<unknown>(`/api/maintenance/${action}`, {
              record_id: item.id,
            });
      if (!res.ok) {
        setNotice({
          ok: false,
          text: `${res.error.code}${res.error.message ? ` · ${res.error.message}` : ""}`,
        });
        return;
      }
      setNotice({ ok: true, text: `${ACTION_LABEL[action]} 已提交` });
      load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "write failed";
      setNotice({ ok: false, text: `INTERNAL · ${message}` });
    } finally {
      setBusy(null);
    }
  }

  const state: PageState = view.state;

  return (
    <PageChrome title="维护" state={state}>
      {view.state === "empty" ? (
        <EmptyCopy code="EMPTY_FAILED_LANE" />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy
          code={view.code}
          message={view.message}
          onRetry={() => load()}
        />
      ) : null}
      {view.state === "ready" ? (
        <FailedTable
          items={view.items}
          busy={busy}
          onRun={(item, action) => void run(item, action)}
        />
      ) : null}
      {notice ? (
        <p
          data-testid="maintenance-notice"
          className={
            notice.ok
              ? "mt-4 font-mono text-xs text-[var(--text-secondary)]"
              : "mt-4 font-mono text-xs text-[var(--danger)]"
          }
        >
          {notice.text}
        </p>
      ) : null}
    </PageChrome>
  );
}

type FailedTableProps = {
  items: FailedRecordItem[];
  busy: string | null;
  onRun: (item: FailedRecordItem, action: ActionKey) => void;
};

function FailedTable({ items, busy, onRun }: FailedTableProps) {
  return (
    <div className="space-y-4" data-testid="maintenance-list">
      <p className="font-mono text-xs text-[var(--text-tertiary)]">
        抽取失败待审 ({items.length})
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left font-mono text-xs text-[var(--text-tertiary)]">
            <th className="py-2 pr-4">失败时间</th>
            <th className="py-2 pr-4">原因</th>
            <th className="py-2 pr-4">提案</th>
            <th className="py-2 pr-4">资料</th>
            <th className="py-2 pr-4">chunk</th>
            <th className="py-2 pr-4">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              data-testid={`maintenance-row-${item.id}`}
              className="border-b border-line align-top"
            >
              <td className="py-3 pr-4 font-mono text-xs">
                {item.finished_at ?? item.created_at ?? "—"}
              </td>
              <td className="py-3 pr-4">
                <span
                  data-testid={`maintenance-code-${item.id}`}
                  className="mr-2 rounded border border-line px-2 py-0.5 font-mono text-xs text-[var(--danger)]"
                >
                  {item.error_code ?? "UNKNOWN"}
                </span>
                <span className="text-xs">{item.error_msg ?? ""}</span>
              </td>
              <td className="py-3 pr-4 font-mono text-xs">
                {item.has_proposal ? "有" : "无"}
              </td>
              <td className="py-3 pr-4 font-mono text-xs">
                {item.source_doc_id !== null ? (
                  <Link
                    to={`/sources/${item.source_doc_id}`}
                    className="text-accent no-underline"
                  >
                    {item.source_ref ?? item.source_doc_id}
                  </Link>
                ) : (
                  (item.source_ref ?? "—")
                )}
              </td>
              <td className="py-3 pr-4 font-mono text-xs">
                {item.chunk_id !== null ? (
                  <Link
                    to={`/browse/chunks/${item.chunk_id}`}
                    className="text-accent no-underline"
                  >
                    {item.chunk_id}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="py-3 pr-4">
                <div className="flex flex-wrap gap-2">
                  {item.has_proposal ? (
                    <ActionButton
                      item={item}
                      action="promote"
                      busy={busy}
                      onRun={onRun}
                    />
                  ) : null}
                  <ActionButton
                    item={item}
                    action="discard"
                    busy={busy}
                    onRun={onRun}
                  />
                  {item.chunk_id !== null ? (
                    <ActionButton
                      item={item}
                      action="re-extract"
                      busy={busy}
                      onRun={onRun}
                    />
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionButton({
  item,
  action,
  busy,
  onRun,
}: {
  item: FailedRecordItem;
  action: ActionKey;
  busy: string | null;
  onRun: (item: FailedRecordItem, action: ActionKey) => void;
}) {
  const key = `${item.id}:${action}`;
  return (
    <button
      type="button"
      disabled={busy !== null}
      onClick={() => onRun(item, action)}
      className="border border-line px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-ink disabled:opacity-40"
    >
      {busy === key ? "…" : ACTION_LABEL[action]}
    </button>
  );
}
