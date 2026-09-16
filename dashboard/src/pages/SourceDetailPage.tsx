import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchJson, SOURCE_STATUS_LABEL, type SourceDetail } from "../api";
import { ErrorCopy, PageChrome, type PageState } from "./PageChrome";
import { SourceWrites } from "./SourceWrites";

type View =
  | { state: "loading" }
  | { state: "ready"; data: SourceDetail }
  | { state: "error"; code: string; message: string };

export function SourceDetailPage() {
  const { id = "" } = useParams();
  const [view, setView] = useState<View>({ state: "loading" });

  const load = useCallback((sourceId: string) => {
    setView({ state: "loading" });
    void fetchJson<SourceDetail>(`/api/sources/${sourceId}`).then((res) => {
      if (!res.ok) {
        setView({
          state: "error",
          code: res.error.code,
          message: res.error.message,
        });
        return;
      }
      setView({ state: "ready", data: res.data });
    });
  }, []);

  useEffect(() => {
    load(id);
  }, [id, load]);

  const state: PageState = view.state;

  return (
    <PageChrome title="资料详情" state={state}>
      <p className="mb-4 font-mono text-xs">
        <Link to="/sources" className="text-accent no-underline">
          ← 资料
        </Link>
      </p>
      {view.state === "error" ? (
        <ErrorCopy
          code={view.code}
          message={view.message}
          onRetry={() => load(id)}
        />
      ) : null}
      {view.state === "ready" ? <SourceBody data={view.data} /> : null}
    </PageChrome>
  );
}

type SourceBodyProps = { data: SourceDetail };

function SourceBody({ data }: SourceBodyProps) {
  const titleLabel = data.title ?? data.source_ref;
  const invalidated = data.valid_until !== null;
  const hasBody = data.content.trim().length > 0;
  const statusLabel = SOURCE_STATUS_LABEL[data.status] ?? data.status;
  return (
    <div className="space-y-3 text-sm" data-testid="source-body">
      <div className="card">
        <h2 className="mb-2 font-display text-xl font-semibold text-title">
          {titleLabel}
        </h2>
        <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-[var(--text-tertiary)]">
          {invalidated ? (
            <span
              data-testid="source-state-invalidated"
              className="rounded border border-line px-2 py-0.5"
            >
              失效 · {data.valid_until}
            </span>
          ) : (
            <span className="rounded border border-line px-2 py-0.5">
              valid
            </span>
          )}
          <span>创建于 {data.created_at}</span>
        </div>
        {/* 四字段 (corpus-ready retrieve T3): 集合 / 身份 / 状态 / 成功块数.
            身份 stays the 资料 id the page was opened with; 状态 is the
            persisted push status, never derived from the validity window. */}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-[var(--text-tertiary)]">
          <div className="flex gap-1">
            <dt>资料集合</dt>
            <dd data-testid="source-detail-collection">{data.collection}</dd>
          </div>
          <div className="flex gap-1">
            <dt>身份</dt>
            <dd data-testid="source-detail-identity">{data.id}</dd>
          </div>
          <div className="flex gap-1">
            <dt>状态</dt>
            <dd data-testid="source-detail-status">{statusLabel}</dd>
          </div>
          <div className="flex gap-1">
            <dt>成功块数</dt>
            <dd data-testid="source-detail-count">{data.chunk_count}</dd>
          </div>
          {data.failure_code !== null ? (
            <div className="flex gap-1">
              <dt>失败码</dt>
              <dd data-testid="source-detail-failure-code">
                {data.failure_code}
              </dd>
            </div>
          ) : null}
        </dl>
        {hasBody ? (
          <article
            className="page-content mt-4 whitespace-pre-wrap text-ink"
            data-testid="source-page-content"
          >
            {data.content}
          </article>
        ) : (
          <div
            className="px-0 py-[30px] text-[var(--text-tertiary)]"
            data-testid="source-page-content"
          >
            <p>无内容</p>
          </div>
        )}
        <div className="action-row" data-testid="source-action-row">
          <SourceWrites sourceRef={data.source_ref} />
        </div>
      </div>
      <div className="card">
        <div className="card-title">提及 (0)</div>
        <div className="text-[13px] text-[var(--text-tertiary)]">暂无提及</div>
      </div>
    </div>
  );
}
