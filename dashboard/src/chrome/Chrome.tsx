import * as Switch from "@radix-ui/react-switch";
import { NavLink } from "react-router-dom";
import { applyTheme, useThemeStore } from "../theme/store";
import { NAV_ITEMS } from "./brand";
import { HeaderSearch } from "./HeaderSearch";

/**
 * Operator-board chrome: wordmark | nav (1fr) | typeahead | 晨纸.
 * PR 214 had put search in the 1fr slot and shoved nav aside; the frozen
 * prototype (`docs/wayfinder/prototypes/operator-board` App.vue header)
 * is logo → nav → search.
 */
export function Chrome() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const paperOn = theme === "晨纸";

  return (
    <header
      className="dashboard-header grid grid-cols-[auto_1fr_auto_auto] items-stretch border-y border-line"
      data-testid="dashboard-header"
    >
      <div className="header-cell header-logo" data-testid="header-logo">
        <p className="font-display text-[1.35rem] font-semibold tracking-tight text-title">
          iknow<span className="font-medium opacity-55">-memory</span>
        </p>
      </div>
      <nav
        className="header-cell header-nav flex gap-6 border-l border-line"
        aria-label="主导航"
        data-testid="header-nav"
      >
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              [
                "text-sm uppercase tracking-wide no-underline",
                isActive
                  ? "text-ink"
                  : "text-[var(--text-secondary)] hover:text-ink",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div
        className="header-cell header-search min-w-[16rem] border-l border-line"
        data-testid="header-search-cell"
      >
        <HeaderSearch />
      </div>
      <label className="header-cell flex items-center gap-2 border-l border-line font-mono text-xs text-[var(--text-secondary)]">
        晨纸
        <Switch.Root
          checked={paperOn}
          onCheckedChange={(checked) => {
            const next = checked ? "晨纸" : "冷墨";
            setTheme(next);
            applyTheme(next, document.documentElement);
          }}
          className="relative h-5 w-9 rounded-full bg-surface outline-none data-[state=checked]:bg-accent"
          aria-label="切换晨纸主题"
        >
          <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-[var(--btn-text)] transition-transform data-[state=checked]:translate-x-4" />
        </Switch.Root>
      </label>
    </header>
  );
}
