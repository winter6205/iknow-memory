import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchJson,
  isEmptyGraph,
  sourcesTotal,
  type GraphBody,
  type PageBody,
} from "../api";
import { PREVIEW_GRAPH } from "../graph/previewGraph";
import { VisGraph } from "../graph/VisGraph";
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
  | { state: "graph-lag" }
  | { state: "ready"; data: GraphBody }
  | { state: "error"; code: string; message: string };

/**
 * Graph-node click handler (operator-console T8). The page receives this
 * as a prop instead of calling `useNavigate` itself so the component
 * stays router-agnostic. Production `App.tsx` wires navigation once.
 */
export type GraphPageProps = {
  onSelectNode?: (id: string) => void;
};

export function GraphPage(props: GraphPageProps = {}) {
  const { onSelectNode } = props;
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get("preview") === "1";
  const [view, setView] = useState<View>(() =>
    isPreview ? { state: "ready", data: PREVIEW_GRAPH } : { state: "loading" }
  );

  const load = useCallback(() => {
    if (isPreview) {
      setView({ state: "ready", data: PREVIEW_GRAPH });
      return;
    }
    setView({ state: "loading" });
    void Promise.all([
      fetchJson<GraphBody>("/api/graph"),
      fetchJson<PageBody<unknown>>("/api/sources?limit=1&offset=0"),
    ]).then(([graph, sources]) => {
      if (!graph.ok) {
        setView({
          state: "error",
          code: graph.error.code,
          message: graph.error.message,
        });
        return;
      }
      if (!isEmptyGraph(graph.data)) {
        setView({ state: "ready", data: graph.data });
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
      setView(
        sourcesTotal(sources.data) > 0
          ? { state: "graph-lag" }
          : { state: "empty" }
      );
    });
  }, [isPreview]);

  useEffect(() => {
    load();
  }, [load]);

  const state: PageState = view.state;
  return (
    <PageChrome title="图谱" state={state}>
      {view.state === "empty" ? (
        <EmptyCopy code={BOARD_CODE.EMPTY_GRAPH} />
      ) : null}
      {view.state === "graph-lag" ? (
        <div className="space-y-3">
          <EmptyCopy code={BOARD_CODE.GRAPH_LAG} />
          <button
            type="button"
            onClick={load}
            className="border border-line px-3 py-1.5 font-mono text-xs text-ink"
          >
            重试
          </button>
        </div>
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} onRetry={load} />
      ) : null}
      {view.state === "ready" ? (
        <div>
          {isPreview ? (
            <p className="mb-2 font-mono text-xs text-[var(--text-secondary)]">
              PREVIEW_GRAPH — demo canvas, not the ledger
            </p>
          ) : null}
          <VisGraph
            data={view.data}
            {...(!isPreview && onSelectNode !== undefined
              ? { onSelectNode }
              : {})}
          />
        </div>
      ) : null}
    </PageChrome>
  );
}
