/** Shared with vite.config.ts — same env name as dashboard-api config. */

export const DASHBOARD_API_PORT_ENV = "GRAPHRAG_MEMORY_DASHBOARD_PORT";
export const DEFAULT_DASHBOARD_API_PORT = 4174;
const SPA_PORT = 18868;

export function dashboardApiProxyTarget(
  env: Record<string, string | undefined>
): string {
  const raw = env[DASHBOARD_API_PORT_ENV]?.trim();
  const port =
    raw === undefined || raw === "" ? DEFAULT_DASHBOARD_API_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `${DASHBOARD_API_PORT_ENV} must be an integer in [0, 65535], got "${raw ?? ""}"`
    );
  }
  if (port === SPA_PORT) {
    throw new Error(
      `${DASHBOARD_API_PORT_ENV} must not be ${SPA_PORT} (reserved for the SPA)`
    );
  }
  return `http://127.0.0.1:${port}`;
}
