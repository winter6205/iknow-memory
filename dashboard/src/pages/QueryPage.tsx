import { type FormEvent, useState } from "react";
import { fetchJson, type QueryBody } from "../api";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "empty"; data: QueryBody }
  | { state: "ready"; data: QueryBody }
  | { state: "error"; code: string; message: string };

function DegradedBanner({ data }: { data: QueryBody }) {
  if (data.degraded !== true) return null;
  return (
    <p
      data-testid="degraded-banner"
      className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs"
    >
      degraded
      {(data.degraded_reasons ?? []).length > 0
        ? ` · ${data.degraded_reasons?.join(", ")}`
        : ""}
    </p>
  );
}

export function QueryPage() {
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>({ state: "idle" });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setView({ state: "loading" });
    const res = await fetchJson<QueryBody>(
      `/api/query?q=${encodeURIComponent(q)}`
    );
    if (!res.ok) {
      setView({
        state: "error",
        code: res.error.code,
        message: res.error.message,
      });
      return;
    }
    if (res.data.chunks.length === 0) {
      setView({ state: "empty", data: res.data });
      return;
    }
    setView({ state: "ready", data: res.data });
  }

  const state: PageState = view.state;
  return (
    <PageChrome title="检索" state={state}>
      <form onSubmit={(e) => void onSubmit(e)} className="mb-6 flex gap-2">
        <input
          role="searchbox"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full max-w-xl rounded-md border border-line bg-surface px-3 py-2 text-sm"
          placeholder="retrieve query"
        />
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-2 font-mono text-xs text-[var(--btn-text)]"
        >
          检索
        </button>
      </form>
      {view.state === "empty" ? (
        <div className="space-y-3">
          <DegradedBanner data={view.data} />
          <EmptyCopy message="没有命中。" />
        </div>
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} />
      ) : null}
      {view.state === "ready" ? (
        <div className="space-y-3">
          <DegradedBanner data={view.data} />
          <ul className="space-y-3">
            {view.data.chunks.map((chunk) => (
              <li key={chunk.id} className="rounded-md border border-line p-3">
                <p className="font-mono text-xs text-[var(--text-tertiary)]">
                  {chunk.source_ref}
                </p>
                <p className="mt-1 text-sm">{chunk.content}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PageChrome>
  );
}
