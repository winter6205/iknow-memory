/**
 * Shared Elasticsearch probe for the integration suites — the ES-side twin
 * of `pg-test-harness.ts`: a lightweight GET against the configured ES URL,
 * classified identically in every suite, so a loud skip always names the
 * real cause and no suite re-implements the transport wrinkle below.
 */

export interface EsProbeResult {
  available: boolean;
  url: string;
  error?: unknown;
}

/**
 * undici collapses every connection failure into a bare `TypeError: fetch
 * failed`; the actionable code (ECONNREFUSED / ENOTFOUND / ECONNRESET)
 * lives on `cause`. Without it a red CI probe says only "fetch failed",
 * which cannot distinguish "nothing is listening" from "the name resolved
 * to the wrong family" — the two failures these suites exist to surface.
 */
function describeFetchFailure(caught: unknown): Error {
  if (!(caught instanceof Error)) return new Error(String(caught));
  const cause = (caught as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.length > 0) {
    const code = (cause as { code?: unknown }).code;
    const suffix = typeof code === "string" ? ` (${code})` : "";
    return new Error(`${caught.message}: ${cause.message}${suffix}`);
  }
  return caught;
}

export async function probeElasticsearch(url: string): Promise<EsProbeResult> {
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return {
        available: false,
        url,
        error: new Error(`HTTP ${response.status} ${response.statusText}`),
      };
    }
    return { available: true, url };
  } catch (caught: unknown) {
    return { available: false, url, error: describeFetchFailure(caught) };
  }
}
