/**
 * dashboard-api config — host + port only.
 *
 * Storage / retrieval / Neo4j come from `loadEnv()` in the caller so this
 * process shares the MCP boot parse. Bind is loopback-only (spec SC1).
 * SPA owns 18868; the API default is 4174.
 */
import { ConfigError, readLayeredEnv } from "../config.js";
const DASHBOARD_HOST_VAR = "GRAPHRAG_MEMORY_DASHBOARD_HOST";
const DASHBOARD_PORT_VAR = "GRAPHRAG_MEMORY_DASHBOARD_PORT";

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4174;
const SPA_PORT = 18868;

export interface DashboardConfig {
  host: string;
  port: number;
}

function readTrimmed(key: string): string | undefined {
  const raw = readLayeredEnv(key);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readDashboardConfig(): DashboardConfig {
  const host = readTrimmed(DASHBOARD_HOST_VAR) ?? DEFAULT_DASHBOARD_HOST;
  if (host !== "127.0.0.1") {
    throw new ConfigError(
      `${DASHBOARD_HOST_VAR} must be 127.0.0.1 (loopback only), got "${host}"`
    );
  }
  const rawPort =
    readTrimmed(DASHBOARD_PORT_VAR) ?? String(DEFAULT_DASHBOARD_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(
      `${DASHBOARD_PORT_VAR} must be an integer in [0, 65535], got "${rawPort}"`
    );
  }
  if (port === SPA_PORT) {
    throw new ConfigError(
      `${DASHBOARD_PORT_VAR} must not be ${SPA_PORT} (reserved for the SPA)`
    );
  }
  return { host, port };
}
