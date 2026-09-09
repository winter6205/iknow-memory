/**
 * Public surface of the dashboard-api bounded context.
 */
export { createDashboardServer, type DashboardServerDeps } from "./server.js";
export {
  readDashboardConfig,
  type DashboardConfig,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
} from "./config.js";
