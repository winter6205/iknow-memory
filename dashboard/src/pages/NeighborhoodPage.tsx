import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchJson, isEmptyNeighborhood, type NeighborhoodBody } from "../api";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; data: NeighborhoodBody }
  | { state: "error"; code: string; message: string };

export function NeighborhoodPage() {
  const { id = "" } = useParams();
  const [view, setView] = useState<View>({ state: "loading" });

  const load = useCallback(() => {
    setView({ state: "loading" });
    void fetchJson<NeighborhoodBody>(`/api/entities/${id}/backlinks`).then(
      (res) => {
        if (!res.ok) {
          setView(
            res.error.code === "NOT_FOUND"
              ? { state: "empty" }
              : {
                  state: "error",
                  code: res.error.code,
                  message: res.error.message,
                }
          );
          return;
        }
        setView(
          isEmptyNeighborhood(res.data)
            ? { state: "empty" }
            : { state: "ready", data: res.data }
        );
      }
    );
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const state: PageState = view.state;
  return (
    <PageChrome title="邻域" state={state}>
      <p className="mb-4 font-mono text-xs">
        <Link
          to={`/browse/entities/${id}`}
          className="text-accent no-underline"
        >
          ← entity
        </Link>
      </p>
      {view.state === "empty" ? <EmptyCopy message="没有入边。" /> : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} onRetry={load} />
      ) : null}
      {view.state === "ready" ? (
        <ul className="space-y-2 text-sm">
          {view.data.inbound.map((edge, index) => (
            <li
              key={`${edge.from}-${edge.to}-${edge.type ?? ""}-${index}`}
              className="rounded-md border border-line p-3 font-mono text-xs"
            >
              {edge.from} → {edge.to}
              {edge.type ? ` · ${edge.type}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </PageChrome>
  );
}
