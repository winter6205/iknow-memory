import { useCallback, useEffect, useState } from "react";
import { fetchJson, isEmptyGraph, type GraphBody } from "../api";
import { VisGraph } from "../graph/VisGraph";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; data: GraphBody }
  | { state: "error"; code: string; message: string };

export function GraphPage() {
  const [view, setView] = useState<View>({ state: "loading" });

  const load = useCallback(() => {
    setView({ state: "loading" });
    void fetchJson<GraphBody>("/api/graph").then((res) => {
      if (!res.ok) {
        setView({
          state: "error",
          code: res.error.code,
          message: res.error.message,
        });
        return;
      }
      setView(
        isEmptyGraph(res.data)
          ? { state: "empty" }
          : { state: "ready", data: res.data }
      );
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const state: PageState = view.state;
  return (
    <PageChrome title="图谱" state={state}>
      {view.state === "empty" ? <EmptyCopy message="Neo4j 投影为空。" /> : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} onRetry={load} />
      ) : null}
      {view.state === "ready" ? <VisGraph data={view.data} /> : null}
    </PageChrome>
  );
}
