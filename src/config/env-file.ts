import { existsSync, readFileSync } from "node:fs";

function ignoredEnvLine(line: string): boolean {
  return !line || line.startsWith("#") || !line.includes("=");
}

function unquoteEnvValue(value: string): string {
  const doubleQuoted = value.startsWith('"') && value.endsWith('"');
  const singleQuoted = value.startsWith("'") && value.endsWith("'");
  if (doubleQuoted || singleQuoted) return value.slice(1, -1);
  return value;
}

function placeholderEnvValue(value: string): boolean {
  return value.startsWith("<") && value.endsWith(">");
}

function parseEnvAssignment(
  raw: string
): { key: string; value: string } | undefined {
  const line = raw.trim();
  if (ignoredEnvLine(line)) return undefined;
  const separator = line.indexOf("=");
  const key = line.slice(0, separator).trim();
  const value = unquoteEnvValue(line.slice(separator + 1).trim());
  if (placeholderEnvValue(value)) return undefined;
  return { key, value };
}

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const assignment = parseEnvAssignment(raw);
    if (assignment === undefined) continue;
    out[assignment.key] = assignment.value;
  }
  return out;
}
