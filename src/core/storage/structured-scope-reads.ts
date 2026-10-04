/**
 * Row reads behind the scoped input views.
 *
 * These are the only places the seam's views touch a table or an authoritative
 * map, so the accepted-corpus and maintenance shapes cannot drift apart per
 * adapter: a status builder and a screening check read exactly the rows the
 * publication writer just locked. A read always runs on the caller's already
 * locked client, never a fresh connection, which is what keeps a snapshot
 * honest instead of merely recent.
 */
import { StructuredScopeError } from "./structured-scope-types.js";
import { isScopedSourceActive } from "./structured-scope-types.js";
import type {
  AcceptedInputSnapshot,
  AuthorizedScopeContext,
  MaintenanceInputSnapshot,
  ScopeTransactionClient,
  ScopedAttributedValue,
  ScopedExtractionInput,
  ScopedMaintenanceSourceInput,
  ScopedMembershipInput,
  ScopedSourceInput,
  ScopedSourcePair,
  ScopedWorkInput,
} from "./structured-scope-types.js";
import type {
  MaintenanceDependency,
  MaintenanceWorkFailureCode,
  MaintenanceWorkKind,
  MaintenanceWorkStatus,
} from "../maintenance/types.js";

/** Refuse here rather than serve a silently absent required record. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      `${field} is missing from the scoped input view`
    );
  }
  return value;
}

export function scopedSafeNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      `${field} is outside the safe integer range`
    );
  }
  return number;
}

function scopedIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "work ledger instant is unreadable"
    );
  }
  return date.toISOString();
}

function toPair(
  version: unknown,
  revision: unknown,
  configRevision?: unknown
): ScopedSourcePair | null {
  if (version === null || version === undefined) return null;
  return {
    sourceVersion: requireText(version, "source_version"),
    extractionRevision: scopedSafeNumber(revision, "extraction revision"),
    ...(configRevision === null || configRevision === undefined
      ? {}
      : { configRevision: String(configRevision) }),
  };
}

export function toScopedSourceRow(
  row: Record<string, unknown>
): ScopedSourceInput {
  const desired = toPair(
    row.desired_source_version,
    row.desired_extraction_revision,
    row.desired_config_revision
  );
  const published = toPair(
    row.published_source_version,
    row.published_extraction_revision
  );
  return {
    sourceRef: requireText(row.source_ref, "source_ref"),
    sourceVersion: desired?.sourceVersion ?? published?.sourceVersion ?? null,
    active: row.active === true,
    generation: scopedSafeNumber(row.generation, "source generation"),
    desired,
    published,
  };
}

/** Current serving membership only: inactive or unpublished sources contribute none. */
export async function readScopedMembership(
  client: ScopeTransactionClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<readonly ScopedMembershipInput[]> {
  const { rows } = await client.query(
    `SELECT m.source_ref, m.support_id::text AS support_id, m.subject,
            m.result_id, m.extraction_ref
       FROM structured_publication_membership m
       JOIN structured_publication_sources s
         ON s.scope_binding = m.scope_binding AND s.source_ref = m.source_ref
        AND s.active AND s.published_generation = m.generation
      WHERE m.scope_binding = $1 AND m.source_ref = ANY($2::text[])
      ORDER BY m.source_ref, m.subject, m.result_id, m.support_id`,
    [scopeBinding, [...sourceRefs]]
  );
  return groupMembershipRows(rows);
}

/**
 * One row per result this scope actually serves, with every support behind it.
 * Grouping here rather than handing the caller a support-per-row fan-out is
 * what keeps a reader from counting the same result twice.
 */
export function groupMembershipRows(
  rows: readonly Record<string, unknown>[]
): ScopedMembershipInput[] {
  const grouped: ScopedMembershipInput[] = [];
  const byResult: Record<string, ScopedMembershipInput & {
    supportIds: string[];
    extractionRefs: string[];
  }> = {};
  for (const row of rows) {
    const sourceRef = requireText(row.source_ref, "source_ref");
    const resultId = requireText(row.result_id, "result_id");
    const key = `${sourceRef}\u0000${resultId}`;
    let entry = byResult[key];
    if (entry === undefined) {
      entry = {
        sourceRef,
        subject: row.subject === "assertion" ? "assertion" : "entity",
        resultId,
        supportIds: [],
        extractionRefs: [],
      };
      byResult[key] = entry;
      grouped.push(entry);
    }
    pushUnique(entry.supportIds, requireText(row.support_id, "support_id"));
    pushUnique(entry.extractionRefs, requireText(row.extraction_ref, "extraction_ref"));
  }
  return grouped;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

/** Extraction refs with the display values attributed to the published revision. */
export async function readScopedExtractions(
  client: ScopeTransactionClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<readonly ScopedExtractionInput[]> {
  const { rows } = await client.query(
    `SELECT m.source_ref, m.extraction_ref, d.support_id::text AS support_id,
            d.extraction_revision, d.canonical_name, d.entity_type
       FROM structured_publication_membership m
       JOIN structured_publication_sources s
         ON s.scope_binding = m.scope_binding AND s.source_ref = m.source_ref
        AND s.active AND s.published_generation = m.generation
       LEFT JOIN structured_publication_display d
         ON d.scope_binding = m.scope_binding AND d.source_ref = m.source_ref
        AND d.support_id = m.support_id
        AND d.extraction_revision = s.published_extraction_revision
      WHERE m.scope_binding = $1 AND m.source_ref = ANY($2::text[])
      ORDER BY m.source_ref, m.extraction_ref, d.support_id`,
    [scopeBinding, [...sourceRefs]]
  );
  return groupExtractionRows(rows);
}

function groupExtractionRows(
  rows: readonly Record<string, unknown>[]
): ScopedExtractionInput[] {
  const grouped: ScopedExtractionInput[] = [];
  const byRef: Record<string, MutableExtraction> = {};
  for (const row of rows) {
    const sourceRef = requireText(row.source_ref, "source_ref");
    const extractionRef = requireText(row.extraction_ref, "extraction_ref");
    const key = sourceRef + "\u0000" + extractionRef;
    let entry = byRef[key];
    if (entry === undefined) {
      entry = { sourceRef, extractionRef, attributedValues: [] };
      byRef[key] = entry;
      grouped.push(entry);
    }
    addAttributedValue(entry, row);
  }
  return grouped;
}

interface MutableExtraction extends ScopedExtractionInput {
  readonly attributedValues: ScopedAttributedValue[];
}

function addAttributedValue(
  entry: MutableExtraction,
  row: Record<string, unknown>
): void {
  if (row.support_id === null || row.support_id === undefined) return;
  entry.attributedValues.push({
    supportId: requireText(row.support_id, "support_id"),
    extractionRevision: scopedSafeNumber(
      row.extraction_revision,
      "display extraction revision"
    ),
    canonicalName: requireText(row.canonical_name, "canonical_name"),
    entityType: requireText(row.entity_type, "entity_type"),
  });
}

/** Required records that vanished mid-transaction refuse instead of reading as empty. */
function assertEverySourcePresent(
  rows: readonly ScopedSourceInput[],
  sourceRefs: readonly string[]
): void {
  const present = new Set(rows.map((row) => row.sourceRef));
  for (const sourceRef of sourceRefs) {
    if (!present.has(sourceRef)) {
      throw new StructuredScopeError(
        "maintenance_status_unavailable",
        `source ${sourceRef} has no scoped row to read`
      );
    }
  }
}

const ACCEPTED_SOURCE_SQL =
  `SELECT source_ref, active, generation, desired_source_version,
          desired_extraction_revision, desired_config_revision,
          published_source_version, published_extraction_revision,
          published_generation
     FROM structured_publication_sources
    WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
    ORDER BY source_ref`;

export async function readPgScopedSourceRows(
  client: ScopeTransactionClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<ScopedSourceInput[]> {
  if (sourceRefs.length === 0) return [];
  const { rows } = await client.query(ACCEPTED_SOURCE_SQL, [
    scopeBinding,
    [...sourceRefs],
  ]);
  const scoped = rows.map(toScopedSourceRow);
  assertEverySourcePresent(scoped, sourceRefs);
  return scoped;
}

export async function buildPgAcceptedSnapshot(
  client: ScopeTransactionClient,
  context: AuthorizedScopeContext,
  sourceRefs: readonly string[],
  readRevision: number
): Promise<AcceptedInputSnapshot> {
  const scopeBinding = context.ownerScopeBinding;
  const rows = await readPgScopedSourceRows(client, scopeBinding, sourceRefs);
  const memberships = await readScopedMembership(client, scopeBinding, sourceRefs);
  const extractions = await readScopedExtractions(client, scopeBinding, sourceRefs);
  const active = rows.filter(isScopedSourceActive);
  const visible = new Set(active.map((row) => row.sourceRef));
  return {
    ownerScopeBinding: scopeBinding,
    readerBinding: context.readerBinding,
    authorizationRevision: context.authorizationRevision,
    readRevision,
    sources: active,
    memberships: memberships.filter((row) => visible.has(row.sourceRef)),
    extractions: extractions.filter((row) => visible.has(row.sourceRef)),
  };
}

/** The ledger rows of the authorized set; hidden or withdrawn sources contribute none. */
export async function readPgScopedWork(
  client: ScopeTransactionClient,
  sourceRefs: readonly string[]
): Promise<readonly ScopedWorkInput[]> {
  if (sourceRefs.length === 0) return [];
  const { rows } = await client.query(
    `SELECT job_key, work_kind, source_ref, source_version, source_generation,
            input_revision, config_revision, status, attempt_count,
            auto_attempt_count, last_failure_code, next_attempt_at, updated_at,
            input_dependencies
       FROM maintenance_jobs
      WHERE source_ref = ANY($1::text[])
      ORDER BY source_ref, updated_at, job_key`,
    [sourceRefs.slice()]
  );
  return rows.map(toScopedWorkInput);
}

export async function buildPgMaintenanceSnapshot(
  client: ScopeTransactionClient,
  context: AuthorizedScopeContext,
  sourceRefs: readonly string[],
  maintenanceRevision: number
): Promise<MaintenanceInputSnapshot> {
  const rows = await readPgScopedSourceRows(
    client,
    context.ownerScopeBinding,
    sourceRefs
  );
  const work = await readPgScopedWork(client, sourceRefs);
  const active = rows.filter(isScopedSourceActive);
  const visible = new Set(active.map((row) => row.sourceRef));
  return {
    ownerScopeBinding: context.ownerScopeBinding,
    readerBinding: context.readerBinding,
    authorizationRevision: context.authorizationRevision,
    maintenanceRevision,
    sources: active.map(toMaintenanceSourceInput),
    work: work.filter((record) => visible.has(record.sourceRef)),
  };
}

function toMaintenanceSourceInput(
  row: ScopedSourceInput
): ScopedMaintenanceSourceInput {
  return {
    sourceRef: row.sourceRef,
    sourceVersion: row.sourceVersion,
    active: row.active,
    generation: row.generation,
    desired: row.desired,
    published: row.published,
  };
}
export function toScopedWorkInput(
  row: Record<string, unknown>
): ScopedWorkInput {
  return {
    jobKey: requireText(row.job_key, "job_key"),
    workKind: requireText(row.work_kind, "work_kind") as MaintenanceWorkKind,
    sourceRef: requireText(row.source_ref, "source_ref"),
    sourceVersion: requireText(row.source_version, "source_version"),
    sourceGeneration: scopedSafeNumber(row.source_generation, "source generation"),
    inputRevision: requireText(row.input_revision, "input_revision"),
    configRevision: requireText(row.config_revision, "config_revision"),
    status: requireText(row.status, "status") as MaintenanceWorkStatus,
    attemptCount: scopedSafeNumber(row.attempt_count, "attempt count"),
    autoAttemptCount: scopedSafeNumber(
      row.auto_attempt_count,
      "auto attempt count"
    ),
    lastFailureCode:
      (row.last_failure_code as MaintenanceWorkFailureCode | null) ?? null,
    nextAttemptAt: scopedIso(row.next_attempt_at),
    updatedAt: requireText(scopedIso(row.updated_at), "updated_at"),
    dependencies: parseScopedDependencies(row.input_dependencies),
  };
}

function parseScopedDependencies(value: unknown): MaintenanceDependency[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "work dependency snapshot is missing from the scoped input view"
    );
  }
  return parsed.map(toDependency);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "work dependency snapshot is not readable"
    );
  }
}

function toDependency(value: unknown): MaintenanceDependency {
  const item = value as Record<string, unknown> | null;
  if (
    item === null ||
    typeof item.sourceRef !== "string" ||
    !Number.isSafeInteger(item.generation)
  ) {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "work dependency entry is malformed"
    );
  }
  return {
    sourceRef: item.sourceRef,
    generation: Number(item.generation),
    extractionRevision:
      item.extractionRevision === null ? null : Number(item.extractionRevision),
    relationBuckets: Array.isArray(item.relationBuckets)
      ? item.relationBuckets.map(String)
      : [],
  };
}
