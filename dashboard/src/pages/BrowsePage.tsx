import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchJson,
  isEmptyPage,
  type ChunkListItem,
  type EntityListItem,
  type PageBody,
} from "../api";
import { EmptyCopy, ErrorCopy, PageChrome, type PageState } from "./PageChrome";

type View =
  | { state: "loading" }
  | { state: "empty" }
  | {
      state: "ready";
      chunks: PageBody<ChunkListItem>;
      entities: PageBody<EntityListItem>;
    }
  | { state: "error"; code: string; message: string };

export function BrowsePage() {
  const [view, setView] = useState<View>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchJson<PageBody<ChunkListItem>>("/api/chunks"),
      fetchJson<PageBody<EntityListItem>>("/api/entities"),
    ]).then(([chunks, entities]) => {
      if (cancelled) return;
      if (!chunks.ok) {
        setView({
          state: "error",
          code: chunks.error.code,
          message: chunks.error.message,
        });
        return;
      }
      if (!entities.ok) {
        setView({
          state: "error",
          code: entities.error.code,
          message: entities.error.message,
        });
        return;
      }
      if (isEmptyPage(chunks.data) && isEmptyPage(entities.data)) {
        setView({ state: "empty" });
        return;
      }
      setView({ state: "ready", chunks: chunks.data, entities: entities.data });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const state: PageState = view.state;
  return (
    <PageChrome title="浏览" state={state}>
      {view.state === "empty" ? (
        <EmptyCopy message="没有 chunk 或 entity。" />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} />
      ) : null}
      {view.state === "ready" ? (
        <div className="grid gap-8 md:grid-cols-2">
          <section>
            <h2 className="font-mono text-xs text-[var(--text-tertiary)]">
              chunks
            </h2>
            <ul className="mt-3 space-y-2">
              {view.chunks.items.map((item) => (
                <li
                  key={item.id}
                  className="rounded-md border border-line p-3 text-sm"
                >
                  <Link
                    to={`/browse/chunks/${item.id}`}
                    className="text-ink no-underline"
                  >
                    {item.content}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-mono text-xs text-[var(--text-tertiary)]">
              entities
            </h2>
            <ul className="mt-3 space-y-2">
              {view.entities.items.map((item) => (
                <li
                  key={item.id}
                  className="rounded-md border border-line p-3 text-sm"
                >
                  <Link
                    to={`/browse/entities/${item.id}`}
                    className="text-ink no-underline"
                  >
                    {item.canonical_name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </PageChrome>
  );
}
