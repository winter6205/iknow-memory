import * as Switch from "@radix-ui/react-switch";
import { NavLink } from "react-router-dom";
import { applyTheme, useThemeStore } from "../theme/store";
import { NAV_ITEMS, WORDMARK } from "./brand";

export function Chrome() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const paperOn = theme === "晨纸";

  return (
    <header className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-line px-6 pb-5 pt-6">
      <p className="font-display text-[1.35rem] font-semibold tracking-tight text-title">
        iknow<span className="font-medium opacity-55">-memory</span>
      </p>
      <nav className="flex gap-1" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              [
                "rounded-md px-3 py-1.5 text-sm no-underline",
                isActive
                  ? "bg-surface text-ink"
                  : "text-[var(--text-secondary)] hover:text-ink",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <label className="flex items-center gap-2 font-mono text-xs text-[var(--text-secondary)]">
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
