import { create } from "zustand";

export type ThemeName = "冷墨" | "晨纸";

export class InvalidThemeError extends Error {
  constructor(value: unknown) {
    super(`illegal theme: ${String(value)}`);
    this.name = "InvalidThemeError";
  }
}

export function parseTheme(value: unknown): ThemeName {
  if (value === "冷墨" || value === "晨纸") {
    return value;
  }
  throw new InvalidThemeError(value);
}

export function applyTheme(
  theme: ThemeName,
  root: { dataset: { theme?: string } }
): void {
  root.dataset.theme = parseTheme(theme);
}

type ThemeState = {
  theme: ThemeName;
  setTheme: (value: unknown) => void;
};

export const useThemeStore = create<ThemeState>((set) => ({
  theme: "冷墨",
  setTheme: (value) => {
    set({ theme: parseTheme(value) });
  },
}));
