/**
 * Flat method+path → handler registry. T3+ add routes; this file stays small.
 */

import { errorEnvelope } from "./responses.js";

export interface DashboardRequest {
  method: string;
  path: string;
  query: string;
  params: Record<string, string>;
  /**
   * Parsed JSON body attached by the http layer for non-GET requests. GET
   * (and other body-less) requests leave this `undefined`. Thin write
   * handlers in `handlers/writes.ts` read this; read-only handlers ignore
   * it. The dashboard-api does not buffer the request body for GET paths
   * — only POST handlers trigger a drain.
   */
  body?: unknown;
}

export type RouteHandler = (
  req: DashboardRequest
) => Promise<unknown> | unknown;

export type ResponseDescriptor = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
};

export interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

export function matchPath(
  pattern: string,
  path: string
): Record<string, string> | undefined {
  const patternParts = pattern.split("/").filter((p) => p.length > 0);
  const pathParts = path.split("/").filter((p) => p.length > 0);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i]!;
    const v = pathParts[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return undefined;
    }
  }
  return params;
}

export function dispatch(
  routes: readonly Route[],
  req: DashboardRequest
): { params: Record<string, string>; handler: RouteHandler } | undefined {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const params = matchPath(r.pattern, req.path);
    if (params !== undefined) return { params, handler: r.handler };
  }
  return undefined;
}

export function notFound(path: string): ResponseDescriptor {
  return {
    status: 404,
    body: errorEnvelope("NOT_FOUND", new Error(`no handler for ${path}`)),
  };
}

export function methodNotAllowed(path: string): ResponseDescriptor {
  return {
    status: 405,
    body: errorEnvelope(
      "METHOD_NOT_ALLOWED",
      new Error(`method not allowed for ${path}`)
    ),
  };
}
