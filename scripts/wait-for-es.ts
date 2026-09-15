/**
 * CI gate: wait until Elasticsearch answers on the HOST's published path.
 *
 * Why this exists (first red run of the `test-es` job, 2026-09-14):
 * `docker compose up --wait` returning "healthy" only proves the container's
 * own loopback healthcheck passed. It does NOT prove the published port is
 * usable from the runner — the gate failed with `curl: (56) Recv failure:
 * Connection reset by peer` from the host while the container was already
 * "Up (healthy)".
 *
 * Two properties this script keeps, both learned from that failure:
 *   - it polls with a deadline instead of betting on one attempt. The
 *     transient is a connection reset, which `curl --retry-connrefused`
 *     does not cover (that covers exit 7 only);
 *   - it uses fetch (undici), the same client the live suite uses, so the
 *     gate cannot pass on a path the suite would fail on. undici hides the
 *     real code in `cause`, which is where ECONNREFUSED / ECONNRESET live.
 *
 * Usage:
 *   ES_URL=http://127.0.0.1:9200 npx tsx scripts/wait-for-es.ts
 *
 * Exit 0 once ES answers; exit 1 after ES_WAIT_TIMEOUT_MS (default 120s),
 * printing the last failure seen so the workflow log carries its own cause.
 */
export {};

const baseUrl = process.env.ES_URL ?? "http://127.0.0.1:9200";
const healthUrl = `${baseUrl.replace(/\/$/, "")}/_cluster/health`;
const timeoutMs = Number(process.env.ES_WAIT_TIMEOUT_MS ?? 120_000);

const deadline = Date.now() + timeoutMs;
let attempt = 0;
let lastFailure = "no attempt";

while (Date.now() < deadline) {
  attempt += 1;
  try {
    const response = await fetch(healthUrl);
    if (response.ok) {
      console.log(
        `wait-for-es: ${healthUrl} answered after ${attempt} attempt(s)`
      );
      process.exit(0);
    }
    lastFailure = `HTTP ${response.status} ${response.statusText}`;
  } catch (caught: unknown) {
    // undici reports a bare "fetch failed"; the actionable detail is on
    // `cause` (message: "bad port", code: ECONNREFUSED / ENOTFOUND / ...).
    const error = caught as {
      message?: string;
      cause?: { message?: string; code?: unknown };
    };
    const cause = error.cause;
    const detail = [
      cause?.message,
      typeof cause?.code === "string" ? cause.code : undefined,
    ]
      .filter(
        (part): part is string => typeof part === "string" && part.length > 0
      )
      .join(" ");
    lastFailure =
      detail.length > 0
        ? `${error.message ?? "fetch failed"}: ${detail}`
        : (error.message ?? String(caught));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.error(
  `wait-for-es: ${healthUrl} unreachable after ${attempt} attempt(s) in ${timeoutMs}ms; last: ${lastFailure}`
);
process.exit(1);
