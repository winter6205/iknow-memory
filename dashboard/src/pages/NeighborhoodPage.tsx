import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchJson,
  isEmptyNeighborhood,
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
  | { state: "ready"; data: NeighborhoodBody }
  | { state: "error"; code: string; message: string };

function NeighborList({
  title,
  items,
}: {
  title: string;
  items: NeighborhoodNeighbor[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="font-mono text-xs uppercase tracking-wide text-[var(--text-tertiary)]">
        {title}
      </h2>
      <ul className="space-y-2 text-sm">
        {items.map((item, index) => (
          <li
            key={`${item.id}-${item.relation ?? ""}-${index}`}
            className="rounded-md border border-line p-3 font-mono text-xs"
          >
            <Link
              to={`/browse/entities/${item.id}`}
              className="text-accent no-underline"
            >
              {item.name || item.id}
            </Link>
            {item.relation ? ` · ${item.relation}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

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
      {view.state === "empty" ? (
        <EmptyCopy code={BOARD_CODE.EMPTY_NEIGHBORHOOD} />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} onRetry={load} />
      ) : null}
      {view.state === "ready" ? (
        <div className="space-y-4">
          <NeighborList title="出链" items={view.data.outbound} />
          <NeighborList title="入链" items={view.data.inbound} />
        </div>
      ) : null}
    </PageChrome>
  );
}
