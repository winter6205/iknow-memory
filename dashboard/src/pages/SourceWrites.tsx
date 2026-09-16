import { useState } from "react";
import { postJson } from "../api";

type WriteKey = "extract" | "invalidate" | "graph-backfill" | "graph-drain";

type SourceWritesProps = {
  sourceRef: string;
};

/**
 * T8 thin writes on 资料 chrome — same HTTP runners as MCP/CLI.
 * Ingest stays on the list (ImportView shape).
 */
export function SourceWrites({ sourceRef }: SourceWritesProps) {
  const [busy, setBusy] = useState<WriteKey | null>(null);
  const [notice, setNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  async function run(key: WriteKey) {
    setBusy(key);
    setNotice(null);
    const path = `/api/writes/${key}`;
    const body =
      key === "extract"
        ? { source_ref: sourceRef }
        : key === "invalidate"
          ? { source_ref: sourceRef, triggered_by: "operator-console" }
          : undefined;
    try {
      const res = await postJson<unknown>(path, body);
      if (!res.ok) {
        setNotice({
          ok: false,
          text: `${res.error.code}${res.error.message ? ` · ${res.error.message}` : ""}`,
        });
        return;
      }
      setNotice({ ok: true, text: `${key} 已提交` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "write failed";
      setNotice({ ok: false, text: `INTERNAL · ${message}` });
    } finally {
      setBusy(null);
    }
  }

  const actions: Array<{ key: WriteKey; label: string }> = [
    { key: "extract", label: "extract" },
    { key: "invalidate", label: "invalidate" },
    { key: "graph-backfill", label: "graph:backfill" },
    { key: "graph-drain", label: "graph:drain" },
  ];

  return (
    <div
      className="space-y-2 border-b border-line pb-4"
      data-testid="source-writes"
    >
      <p className="font-mono text-[0.7rem] uppercase tracking-wide text-[var(--text-tertiary)]">
        维护
      </p>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            disabled={busy !== null}
            onClick={() => void run(action.key)}
            className="border border-line px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-ink disabled:opacity-40"
          >
            {busy === action.key ? "…" : action.label}
          </button>
        ))}
      </div>
      {notice ? (
        <p
          data-testid="source-writes-notice"
          className={
            notice.ok
              ? "font-mono text-xs text-[var(--text-secondary)]"
              : "font-mono text-xs text-[var(--danger)]"
          }
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
