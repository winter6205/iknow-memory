/**
 * T7 SPA — header typeahead. Filters 资料 `title` / `source_ref`
 * in-process against a cheap summaries list read (`GET /api/sources`).
 *
 * Spec assumption 10 (operator-console):
 * - filters `title` / `source_ref`; does NOT call `retrieve`; does NOT embed
 * - selecting an option opens that 资料 (navigates to /sources/:id)
 * - no retrieve-page nav
 *
 * The component fetches the summaries list once on mount and filters
 * client-side. Invalidated docs (valid_until !== null) are excluded from
 * the candidate pool so closed windows never surface as typeahead hits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchJson,
  isEmptyPage,
  type PageBody,
  type SourceSummary,
} from "../api";

/**
 * The typeahead only needs the fields it filters on and displays. Derived
 * from the wire type rather than redeclared so a rename on /api/sources
 * cannot silently drift out of the search suggestions.
 */
type SourceSearchItem = Pick<
  SourceSummary,
  "id" | "source_ref" | "title" | "created_at" | "valid_until"
>;

const TYPEAHEAD_LIMIT = 100;
const TYPEAHEAD_VISIBLE = 8;
const DEBOUNCE_MS = 150;

export function HeaderSearch() {
  const navigate = useNavigate();
  const [items, setItems] = useState<SourceSearchItem[]>([]);
  const [listError, setListError] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void fetchJson<PageBody<SourceSearchItem>>(
      `/api/sources?limit=${TYPEAHEAD_LIMIT}&offset=0`
    ).then((res) => {
      if (!res.ok) {
        setListError(res.error);
        return;
      }
      setListError(null);
      if (isEmptyPage(res.data)) return;
      // Exclude invalidated docs from the in-memory pool so typeahead
      // never surfaces closed windows.
      const alive = res.data.items.filter((doc) => doc.valid_until === null);
      setItems(alive);
    });
  }, []);

  useEffect(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setActiveIndex(-1);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const suggestions = useMemo<SourceSearchItem[]>(() => {
    const q = debouncedQuery.toLowerCase();
    if (q.length === 0) return [];
    return items
      .filter((doc) => {
        if (doc.source_ref.toLowerCase().includes(q)) return true;
        if (doc.title !== null && doc.title.toLowerCase().includes(q)) {
          return true;
        }
        return false;
      })
      .slice(0, TYPEAHEAD_VISIBLE);
  }, [items, debouncedQuery]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(event: PointerEvent) {
      const wrapper = wrapperRef.current;
      if (wrapper === null) return;
      if (!wrapper.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
    };
  }, [open]);

  function commit(doc: SourceSearchItem) {
    setQuery(doc.source_ref);
    setOpen(false);
    setActiveIndex(-1);
    navigate(`/sources/${doc.id}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      // Per spec: header typeahead has no retrieve-page nav. Enter on a
      // suggestion opens that 资料; Enter with no selection is a no-op
      // (does not call retrieve).
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        const doc = suggestions[activeIndex];
        if (doc !== undefined) {
          event.preventDefault();
          commit(doc);
        }
      }
    }
  }

  const showDropdown = open && suggestions.length > 0;

  return (
    <div ref={wrapperRef} className="relative w-full max-w-md">
      <input
        type="search"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="header-search-listbox"
        aria-autocomplete="list"
        data-testid="header-search-input"
        placeholder="搜资料 (source_ref / 标题)…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className="w-full border border-line bg-transparent px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-ink outline-none placeholder:text-[var(--text-tertiary)] focus:border-accent"
      />
      {listError ? (
        <p
          data-testid="header-search-error"
          className="mt-1 font-mono text-[0.625rem] text-[var(--danger)]"
        >
          {listError.code}
          {listError.message ? ` · ${listError.message}` : ""}
        </p>
      ) : null}
      {showDropdown ? (
        <ul
          id="header-search-listbox"
          role="listbox"
          data-testid="header-search-listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-bg shadow-lg"
        >
          {suggestions.map((doc, index) => {
            const titleLabel = doc.title ?? doc.source_ref;
            const isActive = index === activeIndex;
            return (
              <li
                key={doc.id}
                role="option"
                aria-selected={isActive}
                data-testid={`header-search-option-${doc.id}`}
                onMouseDown={(event) => {
                  // mousedown so the input's blur doesn't dismiss the
                  // dropdown before the click handler runs.
                  event.preventDefault();
                  commit(doc);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={
                  "flex flex-col gap-0.5 px-3 py-2 font-mono text-xs cursor-pointer " +
                  (isActive
                    ? "bg-surface text-ink"
                    : "text-[var(--text-secondary)]")
                }
              >
                <span className="text-ink">{titleLabel}</span>
                <span className="text-[var(--text-tertiary)]">
                  {doc.source_ref}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
