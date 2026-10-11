import { createHash } from "node:crypto";

/** Hostname only: scheme, port, path, and userinfo do not participate. */
export function normalizedHostname(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
}

export function hostnameHash(baseUrl: string): string {
  return createHash("sha256")
    .update(normalizedHostname(baseUrl), "utf8")
    .digest("hex");
}
