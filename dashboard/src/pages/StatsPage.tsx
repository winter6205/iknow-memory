import { useEffect, useState } from "react";
import { fetchJson, isEmptyStats, type StatsBody } from "../api";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; data: StatsBody }
  | { state: "error"; code: string; message: string };

export function StatsPage() {
  const [view, setView] = useState<View>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchJson<StatsBody>("/api/stats").then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setView({
          state: "error",
          code: res.error.code,
          message: res.error.message,
        });
        return;
      }
      setView(
        isEmptyStats(res.data)
          ? { state: "empty" }
          : { state: "ready", data: res.data }
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const state: PageState = view.state;
  return (
    <PageChrome title="统计" state={state}>
      {view.state === "empty" ? (
        <EmptyCopy message="账本为空。memory 空账本是合法空态，不是错误。" />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} />
      ) : null}
      {view.state === "ready" ? (
        <dl className="grid max-w-md grid-cols-3 gap-4 font-mono text-sm">
          <div>
            <dt className="text-[var(--text-tertiary)]">chunks</dt>
            <dd className="mt-1 text-xl text-title">{view.data.chunks}</dd>
          </div>
          <div>
            <dt className="text-[var(--text-tertiary)]">entities</dt>
            <dd className="mt-1 text-xl text-title">{view.data.entities}</dd>
          </div>
          <div>
            <dt className="text-[var(--text-tertiary)]">invalidations</dt>
            <dd className="mt-1 text-xl text-title">
              {view.data.invalidations}
            </dd>
          </div>
        </dl>
      ) : null}
    </PageChrome>
  );
}
