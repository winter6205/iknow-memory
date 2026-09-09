import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchJson, type EntityDetail } from "../api";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; data: EntityDetail }
  | { state: "error"; code: string; message: string };

export function EntityDetailPage() {
  const { id = "" } = useParams();
  const [view, setView] = useState<View>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    setView({ state: "loading" });
    void fetchJson<EntityDetail>(`/api/entities/${id}`).then((res) => {
      if (cancelled) return;
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
      setView({ state: "ready", data: res.data });
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const state: PageState = view.state;
  return (
    <PageChrome title="Entity" state={state}>
      <p className="mb-4 font-mono text-xs">
        <Link to="/browse" className="text-accent no-underline">
          ← 浏览
        </Link>
      </p>
      {view.state === "empty" ? (
        <EmptyCopy message="没有这条 entity。" />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} />
      ) : null}
      {view.state === "ready" ? (
        <div className="space-y-3 text-sm">
          <p>{view.data.canonical_name}</p>
          <p className="font-mono text-xs text-[var(--text-tertiary)]">
            {view.data.type ?? ""}
          </p>
          <Link
            to={`/browse/entities/${id}/neighborhood`}
            className="inline-block text-accent no-underline"
          >
            邻域
          </Link>
        </div>
      ) : null}
    </PageChrome>
  );
}
