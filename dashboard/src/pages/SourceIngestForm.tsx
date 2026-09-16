import { useState } from "react";
import { postJson } from "../api";

type SourceIngestFormProps = {
  onDone?: () => void;
};

/** Import-shaped one-slice ingest (prototype ImportView). */
export function SourceIngestForm({ onDone }: SourceIngestFormProps) {
  const [sourceRef, setSourceRef] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ref = sourceRef.trim();
    const body = content;
    if (ref.length === 0 || body.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const res = await postJson<unknown>("/api/writes/ingest", {
      source_ref: ref,
      content: body,
      chunks: [{ content: body, index: 0 }],
    });
    setBusy(false);
    if (!res.ok) {
      setNotice({
        ok: false,
        text: `${res.error.code}${res.error.message ? ` · ${res.error.message}` : ""}`,
      });
      return;
    }
    setSourceRef("");
    setContent("");
    setNotice({ ok: true, text: "ingest 已提交" });
    onDone?.();
  }

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mb-6 space-y-3 border-b border-line pb-6"
      data-testid="source-ingest"
    >
      <p className="font-mono text-[0.7rem] uppercase tracking-wide text-[var(--text-tertiary)]">
        导入
      </p>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-[var(--text-secondary)]">
          source_ref
        </span>
        <input
          name="source_ref"
          value={sourceRef}
          onChange={(event) => setSourceRef(event.target.value)}
          className="w-full border border-line bg-transparent px-3 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-[var(--text-secondary)]">
          资料正文
        </span>
        <textarea
          name="content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={6}
          className="w-full border border-line bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none focus:border-accent"
        />
      </label>
      <button
        type="submit"
        disabled={busy || sourceRef.trim().length === 0 || content.length === 0}
        className="border border-line px-4 py-1.5 font-mono text-xs uppercase tracking-wide text-ink disabled:opacity-40"
      >
        {busy ? "提交中…" : "ingest"}
      </button>
      {notice ? (
        <p
          data-testid="source-ingest-notice"
          className={
            notice.ok
              ? "font-mono text-xs text-[var(--text-secondary)]"
              : "font-mono text-xs text-[var(--danger)]"
          }
        >
          {notice.text}
        </p>
      ) : null}
    </form>
  );
}
