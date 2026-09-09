import type { ReactNode } from "react";

export type PageState = "loading" | "empty" | "error" | "ready" | "idle";

type PageChromeProps = {
  title: string;
  state: PageState;
  children: ReactNode;
};

export function PageChrome({ title, state, children }: PageChromeProps) {
  return (
    <main className="px-6 py-8" data-testid={`page-state-${state}`}>
      <h1 className="font-display text-2xl font-semibold text-title">
        {title}
      </h1>
      <div className="mt-6">{children}</div>
    </main>
  );
}

type EmptyProps = { message: string };

export function EmptyCopy({ message }: EmptyProps) {
  return <p className="text-sm text-[var(--text-secondary)]">{message}</p>;
}

type ErrorCopyProps = {
  code: string;
  message: string;
  onRetry?: () => void;
};

export function ErrorCopy({ code, message, onRetry }: ErrorCopyProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--danger)]">
        {code}
        {message ? ` · ${message}` : ""}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-xs text-[var(--btn-text)]"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
