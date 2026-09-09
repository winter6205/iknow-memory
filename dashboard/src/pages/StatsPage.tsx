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
  const tiles =
    view.state === "ready"
      ? view.data
      : view.state === "empty"
        ? { chunks: 0, entities: 0, invalidations: 0 }
        : null;
  return (
    <PageChrome title="统计" state={state}>
      {tiles ? (
        <dl className="mb-4 grid max-w-3xl grid-cols-3 gap-3">
          {(
            [
              ["Chunks", tiles.chunks],
              ["Entities", tiles.entities],
              ["Invalidations", tiles.invalidations],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-line bg-surface p-4"
            >
              <dt className="mb-1 text-[0.7rem] uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                {label}
              </dt>
              <dd className="font-display text-[1.75rem] leading-none text-title">
                {value.toLocaleString("en-US")}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.state === "empty" ? (
        <EmptyCopy message="账本为空。memory 空账本是合法空态，不是错误。" />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} />
      ) : null}
    </PageChrome>
  );
}
