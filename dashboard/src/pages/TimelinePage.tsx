import { useEffect, useState } from "react";
import {
  fetchJson,
  isEmptyPage,
  type PageBody,
  type TimelineItem,
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
  | { state: "ready"; data: PageBody<TimelineItem> }
  | { state: "error"; code: string; message: string };

export function TimelinePage() {
  const [view, setView] = useState<View>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchJson<PageBody<TimelineItem>>("/api/timeline").then((res) => {
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
        isEmptyPage(res.data)
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
    <PageChrome title="时间线" state={state}>
      {view.state === "empty" ? (
        <EmptyCopy code={BOARD_CODE.EMPTY_TIMELINE} />
      ) : null}
      {view.state === "error" ? (
        <ErrorCopy code={view.code} message={view.message} />
      ) : null}
      {view.state === "ready" ? (
        <>
          <p className="mb-3 font-mono text-xs text-[var(--text-tertiary)]">
            窗口事件：ingest / invalidate 等写入时刻，不是资料阅读顺序。
          </p>
          <ol className="space-y-2 font-mono text-sm">
            {view.data.items.map((item, index) => (
              <li
                key={`${item.kind}-${item.at}-${index}`}
                className="border-l border-line pl-3"
              >
                <span className="text-[var(--text-tertiary)]">{item.at}</span>{" "}
                {item.kind}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </PageChrome>
  );
}
