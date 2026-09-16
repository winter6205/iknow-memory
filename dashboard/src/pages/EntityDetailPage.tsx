import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchJson,
  type EntityDetail,
  type NeighborhoodBody,
  type NeighborhoodNeighbor,
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
  | {
      state: "ready";
      data: EntityDetail;
      inbound: NeighborhoodNeighbor[];
      outbound: NeighborhoodNeighbor[];
    }
  | { state: "error"; code: string; message: string };

function NeighborCard({
  title,
  items,
}: {
  title: string;
  items: NeighborhoodNeighbor[];
}) {
  return (
    <div className="card">
      <div className="card-title">
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="text-[13px] text-[var(--text-tertiary)]">
          暂无{title}
        </div>
      ) : (
        <ul className="space-y-1 text-[13px]">
          {items.map((item, index) => (
            <li key={`${item.id}-${item.relation ?? ""}-${index}`}>
              <Link
                to={`/browse/entities/${item.id}`}
                className="text-accent no-underline"
              >
                {item.name}
              </Link>
              {item.relation ? ` · ${item.relation}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
      void fetchJson<NeighborhoodBody>(`/api/entities/${id}/backlinks`).then(
        (links) => {
          if (cancelled) return;
          if (!links.ok) {
            setView({
              state: "error",
              code: links.error.code,
              message: links.error.message,
            });
            return;
          }
          setView({
            state: "ready",
            data: res.data,
            inbound: links.data.inbound,
            outbound: links.data.outbound,
          });
        }
      );
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
        <EmptyCopy code={BOARD_CODE.NOT_FOUND} />
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
          <NeighborCard title="出链" items={view.outbound} />
          <NeighborCard title="入链" items={view.inbound} />
        </div>
      ) : null}
    </PageChrome>
  );
}
