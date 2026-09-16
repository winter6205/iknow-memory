import { useCallback, useEffect, useState } from "react";
import {
  fetchJson,
  isEmptyStats,
  sourcesTotal,
  type PageBody,
  type StatsBody,
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
  | { state: "ready"; data: StatsBody; sources: number }
  | { state: "error"; code: string; message: string };

export function StatsPage() {
  const [view, setView] = useState<View>({ state: "loading" });

  const load = useCallback(() => {
    setView({ state: "loading" });
    void Promise.all([
      fetchJson<StatsBody>("/api/stats"),
      fetchJson<PageBody<unknown>>("/api/sources?limit=1&offset=0"),
    ]).then(([stats, sources]) => {
      if (!stats.ok) {
        setView({
          state: "error",
          code: stats.error.code,
          message: stats.error.message,
        });
        return;
      }
      if (!sources.ok) {
        setView({
          state: "error",
          code: sources.error.code,
          message: sources.error.message,
        });
        return;
      }
      const sourceCount = sourcesTotal(sources.data);
      setView(
        isEmptyStats(stats.data) && sourceCount === 0
          ? { state: "empty" }
          : { state: "ready", data: stats.data, sources: sourceCount }
      );
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const state: PageState = view.state;
  const tiles =
    view.state === "ready"
      ? {
          资料: view.sources,
          Chunks: view.data.chunks,
          Entities: view.data.entities,
          Invalidations: view.data.invalidations,
        }
      : view.state === "empty"
        ? { 资料: 0, Chunks: 0, Entities: 0, Invalidations: 0 }
        : null;
  return (
    <PageChrome title="统计" state={state}>
      {tiles ? (
        <dl className="mb-4 grid max-w-4xl grid-cols-4 gap-3">
          {(
            [
              ["资料", tiles.资料],
              ["Chunks", tiles.Chunks],
              ["Entities", tiles.Entities],
              ["Invalidations", tiles.Invalidations],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-line bg-surface p-4"
              data-testid={`stat-tile-${label}`}
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
        <EmptyCopy code={BOARD_CODE.EMPTY_LEDGER} />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} onRetry={load} />
      ) : null}
    </PageChrome>
  );
}
