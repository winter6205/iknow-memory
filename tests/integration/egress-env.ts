/**
 * Shared egress wiring for the gold harnesses that spawn real child processes.
 *
 * Node reads proxy settings only with `NODE_USE_ENV_PROXY` set, and this box
 * reaches the live embedding and LLM endpoints through its egress proxy only.
 * A child built without these vars answers `fetch failed` — measured 2/8 embed
 * and 0/3 completion direct against 8/8 and 3/3 through the proxy — so such a
 * failure is the harness's routing, not a fault of the code under test.
 *
 * Only the variable _names_ are copied from the parent environment and values
 * are never printed by either harness, so no proxy URL or credential reaches
 * the test output.
 */
const EGRESS_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
];

/** The operator's egress settings, copied by name so no value is logged. */
export function egressEnv(): Record<string, string> {
  const copied: Record<string, string> = {};
  for (const name of EGRESS_VARS) {
    const value = process.env[name];
    if (value !== undefined && value !== "") copied[name] = value;
  }
  const proxyNamed = Object.keys(copied).some(
    (name) => name !== "NODE_USE_ENV_PROXY"
  );
  if (proxyNamed && copied.NODE_USE_ENV_PROXY === undefined) {
    copied.NODE_USE_ENV_PROXY = "1";
  }
  return copied;
}
