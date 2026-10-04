/** Shared SQL rendering and client contract for idempotent schema setup. */

/**
 * Render a status vocabulary as a SQL literal list for a CHECK constraint.
 * Values are compile-time constants; quoting remains defensive so a future
 * value containing a quote cannot silently break the DDL.
 */
export function sqlTextList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/** A single value as a SQL literal — same escaping as the CHECK's list. */
export function sqlTextLiteral(value: string): string {
  return sqlTextList([value]);
}

/**
 * Minimal query surface consumed by schema setup. Pool clients, pools and the
 * CLI's leased clients satisfy it structurally; this module owns no lifecycle.
 */
export interface SchemaBootstrapClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
