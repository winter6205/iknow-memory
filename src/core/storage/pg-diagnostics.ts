/**
 * PostgreSQL diagnostic redaction shared by production and integration code.
 *
 * PostgreSQL connection strings may carry credentials in the authority or
 * secret-bearing query parameters. Diagnostics are also allowed to contain a
 * bare key/value pair, so redacting only a URL is not sufficient.
 */

const POSTGRES_URL_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s"'`<>]+/gi;
const KEY_VALUE_SECRET_PATTERN =
  /((?:["']?\b(?:user|username|password|passwd|pwd|pass|sslpassword|ssl_pass(?:word)?|ssl-pass(?:word)?)\b["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;

function parseConnectionUrl(connectionString: string): URL | undefined {
  if (!URL.canParse(connectionString)) return undefined;
  const url = new URL(connectionString);
  return /^postgres(?:ql)?:$/i.test(url.protocol) ? url : undefined;
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error: unknown) {
    if (error instanceof URIError) return value;
    throw error;
  }
}

function isSecretKey(key: string): boolean {
  return /^(?:user|username|password|passwd|pwd|pass|sslpassword|ssl_pass(?:word)?|ssl-pass(?:word)?)$/i.test(
    key
  );
}

function collectSecretValues(connectionString: string): string[] {
  const values: string[] = [];
  const add = (value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    values.push(value, decodeUrlComponent(value));
  };

  add(connectionString);
  for (const match of connectionString.matchAll(KEY_VALUE_SECRET_PATTERN)) {
    add(match[0].slice(match[1].length));
  }

  const url = parseConnectionUrl(connectionString);
  if (url === undefined) return values;

  add(url.username);
  add(url.password);
  for (const [key, value] of url.searchParams) {
    if (isSecretKey(key)) add(value);
  }
  return values.filter(
    (value, index, all) => value.length > 0 && all.indexOf(value) === index
  );
}

/**
 * Keep only non-sensitive location information from a PostgreSQL URL.
 *
 * Query parameters are intentionally discarded. This covers `sslpassword`
 * and future credential-bearing parameters without needing to enumerate them
 * in the safe output.
 */
export function redactPgConnectionString(connectionString: string): string {
  const url = parseConnectionUrl(connectionString);
  if (url === undefined) return "postgresql://[redacted]";

  const host = url.hostname || "unknown-host";
  const database =
    decodeUrlComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "") ||
    "unknown-database";
  return `postgresql://${host}/${encodeURIComponent(database)}`;
}

function redactPostgresUrls(diagnostic: string): string {
  return diagnostic.replace(POSTGRES_URL_PATTERN, (candidate) => {
    const trailing = candidate.match(/[.,;:!?)}\]]+$/)?.[0] ?? "";
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${redactPgConnectionString(url)}${trailing}`;
  });
}

function redactKeyValueSecrets(diagnostic: string): string {
  return diagnostic.replace(
    KEY_VALUE_SECRET_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted]`
  );
}

/**
 * Redact a driver/constructor diagnostic before it reaches logs or stderr.
 *
 * Error stacks are used when available because constructor and driver
 * failures commonly carry their useful context there. `connectionString`
 * remains optional so callers can scrub a known URL even when a driver error
 * only exposes individual credential fields.
 */
export function redactPgDiagnostic(
  error: unknown,
  connectionString?: string
): string {
  let diagnostic =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  diagnostic = redactPostgresUrls(diagnostic);
  const secrets = connectionString ? collectSecretValues(connectionString) : [];
  for (const secret of secrets) {
    diagnostic = diagnostic.split(secret).join("[redacted]");
  }
  return redactKeyValueSecrets(diagnostic);
}
