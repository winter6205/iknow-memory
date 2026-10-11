import { join } from "node:path";

const DIR_NAME = ".iknow-memory";

export class MemoryHomeMissingError extends Error {
  constructor() {
    super("IKNOW_MEMORY_HOME or HOME is required");
    this.name = "MemoryHomeMissingError";
  }
}

export function resolveMemoryHome(input: {
  iknowMemoryHome?: string | undefined;
  osHome?: string | undefined;
}): string {
  const directed = input.iknowMemoryHome?.trim() ?? "";
  if (directed !== "") return directed;
  const osHome = input.osHome?.trim() ?? "";
  if (osHome !== "") return join(osHome, DIR_NAME);
  throw new MemoryHomeMissingError();
}

/** `osHomeOverride` replaces `$HOME`. `null` follows `IKNOW_MEMORY_HOME` or `~/.iknow-memory`. */
export function memoryHomeDirectory(osHomeOverride: string | null): string {
  if (osHomeOverride !== null) return join(osHomeOverride, DIR_NAME);
  return resolveMemoryHome({
    iknowMemoryHome: process.env.IKNOW_MEMORY_HOME,
    osHome: process.env.HOME,
  });
}

export function defaultEvalOutputDir(): string {
  return join(memoryHomeDirectory(null), "gold-set");
}
