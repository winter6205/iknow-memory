/**
 * PostgreSQL statements for the immutable source/support records and the
 * finite grants.
 *
 * One file so every statement against the evidence tables is auditable in
 * one place, the way projection-outbox.ts keeps `projection_outbox` in one
 * place. The decisions — what is valid, when a grant expires, why a replay is
 * denied — are NOT here: they live in evidence-store.ts and both backends run
 * them, so a denied replay is denied for the same reason in either store.
 */
import { GraphragError, recordSuppressedFailure } from "../errors.js";
import {
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  type AuthorizationReceipt,
  type EvidenceGrantRecord,
  type EvidenceSupportRef,
  type GrantDependencyFact,
  type ScopeRevisionRecord,
  type SourceLocatorBinding,
  type SourceVersionRecord,
  type SupportRecord,
} from "../types.js";
import {
  canonicalJson,
  evidenceError,
  instantText,
  locationOfColumns,
  spanOfColumns,
  type NormalizedSourceVersion,
  type NormalizedSupport,
  type SourceVersionStamp,
} from "./evidence-source.js";
import type {
  EvidenceClient,
  EvidenceLeasedClient,
  GrantReadFacts,
  NormalizedGrant,
} from "./evidence-store.js";

const SOURCE_VERSION_COLUMNS = `source_version_id, source_ref, source_version,
  content_digest, origin_object_ref, parser_revision, unit_manifest, created_at,
  retired_at, payload_collected_at, obligations_stopped_at`;

const SUPPORT_COLUMNS = `support_id, subject, result_id, source_ref,
  source_version, source_version_id, document_id, unit_version, unit,
  span_start, span_end, created_at`;

/** The same columns, qualified for the dependency join below. */
const QUALIFIED_SUPPORT_COLUMNS = `s.support_id, s.subject, s.result_id,
  s.source_ref, s.source_version, s.source_version_id, s.document_id,
  s.unit_version, s.unit, s.span_start, s.span_end, s.created_at`;

const GRANT_COLUMNS = `evidence_ref, grant_kind, subject, operation, query_digest,
  scope_binding, read_revision, authorization_revision, purge_revision, queried_at,
  expires_at, context, value, result_count, authorization_receipt_id, consumer_id`;

const RECEIPT_COLUMNS = `receipt_id, scope_binding, authorization_revision,
  purge_revision, created_at`;

/** The occurrence key, as the unique constraint spells it. */
const OCCURRENCE_KEY = `subject, result_id, source_ref, source_version,
  document_id, unit_version, unit, span_start, span_end`;

/**
 * One statement per lifecycle stamp, keyed by a closed literal union — the
 * column name can never arrive from a caller, so this is not an injection
 * surface even though a column name is interpolated.
 */
const STAMP_SQL: Record<SourceVersionStamp, string> = {
  retired_at: `UPDATE source_versions SET retired_at = $2::timestamptz`,
  payload_collected_at: `UPDATE source_versions SET payload_collected_at = $2::timestamptz`,
  obligations_stopped_at: `UPDATE source_versions SET obligations_stopped_at = $2::timestamptz`,
};

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toSourceVersionRecord(row: Record<string, any>): SourceVersionRecord {
  return {
    source_version_id: row.source_version_id as string,
    source_ref: row.source_ref as string,
    source_version: row.source_version as string,
    content_digest: row.content_digest as string,
    origin_object_ref: row.origin_object_ref as string,
    parser_revision: row.parser_revision as string,
    unit_manifest: row.unit_manifest as Record<string, unknown>,
    created_at: isoOrNull(row.created_at)!,
    retired_at: isoOrNull(row.retired_at),
    payload_collected_at: isoOrNull(row.payload_collected_at),
    obligations_stopped_at: isoOrNull(row.obligations_stopped_at),
  };
}

function toSupportRecord(row: Record<string, any>): SupportRecord {
  return {
    support_id: row.support_id as string,
    subject: row.subject as SupportRecord["subject"],
    result_id: row.result_id as string,
    source_ref: row.source_ref as string,
    source_version: row.source_version as string,
    source_version_id: row.source_version_id as string,
    location: locationOfColumns(row),
    span: spanOfColumns(row),
    created_at: isoOrNull(row.created_at)!,
  };
}

function toGrantRecord(row: Record<string, any>): EvidenceGrantRecord {
  return {
    evidence_ref: row.evidence_ref as string,
    kind: row.grant_kind as EvidenceGrantRecord["kind"],
    subject: row.subject as EvidenceGrantRecord["subject"],
    operation: row.operation as string,
    query_digest: row.query_digest as string,
    scope_binding: row.scope_binding as string,
    read_revision: row.read_revision as string,
    authorization_revision: row.authorization_revision as string,
    purge_revision: row.purge_revision as string,
    queried_at: isoOrNull(row.queried_at)!,
    expires_at: isoOrNull(row.expires_at)!,
    context: row.context as Record<string, unknown>,
    value: row.value,
    result_count: row.result_count === null ? null : Number(row.result_count),
    authorization_receipt_id:
      row.authorization_receipt_id === null
        ? null
        : (row.authorization_receipt_id as string),
    consumer_id: String(row.consumer_id),
  };
}

function toReceipt(row: Record<string, any>): AuthorizationReceipt {
  return {
    receipt_id: row.receipt_id as string,
    scope_binding: row.scope_binding as string,
    authorization_revision: row.authorization_revision as string,
    purge_revision: row.purge_revision as string,
    created_at: isoOrNull(row.created_at)!,
  };
}

function toScopeRevisions(row: Record<string, any>): ScopeRevisionRecord {
  return {
    scope_binding: row.scope_binding as string,
    authorization_revision: row.authorization_revision as string,
    purge_revision: row.purge_revision as string,
  };
}

/** A lost write is a storage fault, never a domain miss to be swallowed. */
function requireRow(rows: unknown[], statement: string): Record<string, any> {
  const row = rows[0] as Record<string, any> | undefined;
  if (row === undefined) {
    throw new GraphragError(
      `evidence store: ${statement} wrote no row`,
      "STORAGE_ERROR"
    );
  }
  return row;
}

/**
 * Run one evidence write set inside its own transaction. The lease and the
 * BEGIN/COMMIT/ROLLBACK pairing live here so no caller can leave a grant half
 * written: a reference and its dependencies commit together or not at all.
 */
export async function inEvidenceTransaction<T>(
  lease: () => Promise<EvidenceLeasedClient>,
  body: (client: EvidenceClient) => Promise<T>
): Promise<T> {
  const client = await lease();
  let started = false;
  try {
    await client.query("BEGIN", []);
    started = true;
    const out = await body(client);
    await client.query("COMMIT", []);
    return out;
  } catch (err) {
    let rollbackFailure: { readonly error: unknown } | undefined;
    if (started) {
      try {
        await client.query("ROLLBACK", []);
      } catch (rollbackError) {
        rollbackFailure = { error: rollbackError };
      }
    }
    const primary =
      err instanceof GraphragError
        ? err
        : new GraphragError(
            `evidence store write failed: ${err instanceof Error ? err.message : String(err)}`,
            "STORAGE_ERROR"
          );
    if (rollbackFailure !== undefined) {
      recordSuppressedFailure(primary, rollbackFailure.error);
    }
    throw primary;
  } finally {
    client.release();
  }
}

/**
 * Insert one immutable source version, or join the row that already owns the
 * (source_ref, source_version) key. A join is only valid when the immutable
 * content agrees: a changed digest, origin object, parser revision or unit
 * manifest is a different source version, and quietly returning the old row
 * would attribute new parsing to a version that never had it.
 */
export async function registerSourceVersionRow(
  client: EvidenceClient,
  plan: NormalizedSourceVersion
): Promise<{ record: SourceVersionRecord; created: boolean }> {
  const inserted = await client.query(
    `INSERT INTO source_versions
       (source_version_id, source_ref, source_version, content_digest,
        origin_object_ref, parser_revision, unit_manifest, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
     ON CONFLICT (source_ref, source_version) DO NOTHING
     RETURNING ${SOURCE_VERSION_COLUMNS}`,
    [
      plan.source_version_id,
      plan.source_ref,
      plan.source_version,
      plan.content_digest,
      plan.origin_object_ref,
      plan.parser_revision,
      plan.unit_manifest_canonical,
      plan.created_at,
    ]
  );
  if (inserted.rows.length > 0) {
    return {
      record: toSourceVersionRecord(inserted.rows[0] as Record<string, any>),
      created: true,
    };
  }
  const { rows } = await client.query(
    `SELECT ${SOURCE_VERSION_COLUMNS} FROM source_versions
      WHERE source_ref = $1 AND source_version = $2`,
    [plan.source_ref, plan.source_version]
  );
  const existing = toSourceVersionRecord(
    requireRow(rows, "the source version insert that resolved to nothing")
  );
  if (!sameImmutableVersion(existing, plan)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `source version "${plan.source_ref}/${plan.source_version}" already exists with different immutable content; a changed unit manifest is a new source version`
    );
  }
  return { record: existing, created: false };
}

/** The immutable half two spellings of one version key must agree on. */
function sameImmutableVersion(
  existing: SourceVersionRecord,
  plan: NormalizedSourceVersion
): boolean {
  return (
    existing.content_digest === plan.content_digest &&
    existing.origin_object_ref === plan.origin_object_ref &&
    existing.parser_revision === plan.parser_revision &&
    canonicalJson(existing.unit_manifest) === plan.unit_manifest_canonical
  );
}

/**
 * Bind one company locator to a source version. The key is the whole binding,
 * so a repeat writes nothing and returns the same binding — there is no
 * mutable field on it that a second write could change.
 */
export async function bindSourceLocatorRow(
  client: EvidenceClient,
  binding: SourceLocatorBinding
): Promise<SourceLocatorBinding> {
  const version = await client.query(
    `SELECT 1 FROM source_versions WHERE source_version_id = $1`,
    [binding.source_version_id]
  );
  if (version.rows.length === 0) {
    throw evidenceError(
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      `locator binding names source version ${binding.source_version_id}, which is not registered`
    );
  }
  await client.query(
    `INSERT INTO source_version_locators
       (source_version_id, document_id, unit_version, unit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_version_id, document_id, unit_version, unit) DO NOTHING`,
    [
      binding.source_version_id,
      binding.document_id,
      binding.version,
      binding.unit,
    ]
  );
  return { ...binding };
}

/** The source version an occurrence names, or the refusal that says none does. */
async function requireSourceVersion(
  client: EvidenceClient,
  support: NormalizedSupport
): Promise<string> {
  const { rows } = await client.query(
    `SELECT source_version_id FROM source_versions
      WHERE source_ref = $1 AND source_version = $2`,
    [support.source_ref, support.source_version]
  );
  const row = rows[0] as { source_version_id?: string } | undefined;
  if (row?.source_version_id === undefined) {
    throw evidenceError(
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      `support names source version "${support.source_ref}/${support.source_version}", which is not registered`
    );
  }
  return row.source_version_id;
}

/**
 * The occurrence's locator must be one this exact source version declared.
 * The two version strings are allowed to differ (the source version key and
 * the frozen-unit version are different namespaces); an undeclared pairing is
 * not, and admitting it would let any locator be cited under any source.
 */
async function requireLocatorBinding(
  client: EvidenceClient,
  sourceVersionId: string,
  support: NormalizedSupport
): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM source_version_locators
      WHERE source_version_id = $1 AND document_id = $2
        AND unit_version = $3 AND unit = $4`,
    [
      sourceVersionId,
      support.location.document_id,
      support.location.version,
      support.location.unit,
    ]
  );
  if (rows.length === 0) {
    throw evidenceError(
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      `source version ${sourceVersionId} does not bind locator ${support.location.document_id}/${support.location.version}/${support.location.unit}`
    );
  }
}

export async function recordSupportRow(
  client: EvidenceClient,
  support: NormalizedSupport,
  supportId: string
): Promise<{ support: SupportRecord; created: boolean }> {
  const sourceVersionId = await requireSourceVersion(client, support);
  await requireLocatorBinding(client, sourceVersionId, support);
  const bound = { ...support, source_version_id: sourceVersionId };
  const outcome = await insertSupport(client, bound, supportId);
  await linkExtraction(client, outcome.support.support_id, support);
  return outcome;
}

type BoundSupport = NormalizedSupport & { readonly source_version_id: string };

function supportValues(support: BoundSupport, supportId: string): unknown[] {
  return [
    supportId,
    support.subject,
    support.result_id,
    support.source_ref,
    support.source_version,
    support.source_version_id,
    support.location.document_id,
    support.location.version,
    support.location.unit,
    support.span?.start ?? -1,
    support.span?.end ?? -1,
    support.extracted_at,
  ];
}

/**
 * The occurrence insert, then the extraction link. Both are keyed so a repeat
 * of the same extraction is a no-op, which is what lets a re-run of the same
 * extraction add a second link without inventing a second support.
 */
async function insertSupport(
  client: EvidenceClient,
  support: BoundSupport,
  supportId: string
): Promise<{ support: SupportRecord; created: boolean }> {
  const inserted = await client.query(
    `INSERT INTO assertion_supports
       (support_id, subject, result_id, source_ref, source_version,
        source_version_id, document_id, unit_version, unit, span_start, span_end,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
     ON CONFLICT (${OCCURRENCE_KEY}) DO NOTHING
     RETURNING ${SUPPORT_COLUMNS}`,
    supportValues(support, supportId)
  );
  if (inserted.rows.length > 0) {
    return {
      support: toSupportRecord(inserted.rows[0] as Record<string, any>),
      created: true,
    };
  }
  const occurrenceValues = [
    support.subject,
    support.result_id,
    support.source_ref,
    support.source_version,
    support.location.document_id,
    support.location.version,
    support.location.unit,
    support.span?.start ?? -1,
    support.span?.end ?? -1,
  ];
  const { rows } = await client.query(
    `SELECT ${SUPPORT_COLUMNS} FROM assertion_supports
      WHERE (${OCCURRENCE_KEY}) = ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    occurrenceValues
  );
  return {
    support: toSupportRecord(
      requireRow(
        rows,
        "the support insert that resolved to an existing occurrence"
      )
    ),
    created: false,
  };
}

async function linkExtraction(
  client: EvidenceClient,
  supportId: string,
  support: NormalizedSupport
): Promise<void> {
  await client.query(
    `INSERT INTO support_extractions (support_id, extraction_ref, created_at)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (support_id, extraction_ref) DO NOTHING`,
    [supportId, support.extraction_ref, support.extracted_at]
  );
}

export async function readSupportRow(
  client: EvidenceClient,
  supportId: string
): Promise<SupportRecord | null> {
  const { rows } = await client.query(
    `SELECT ${SUPPORT_COLUMNS} FROM assertion_supports WHERE support_id = $1`,
    [supportId]
  );
  return rows.length === 0
    ? null
    : toSupportRecord(rows[0] as Record<string, any>);
}

/** Oldest first, with the reference breaking ties so the order is total. */
export async function readSupportExtractionRefs(
  client: EvidenceClient,
  supportId: string
): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT extraction_ref FROM support_extractions
      WHERE support_id = $1 ORDER BY created_at, extraction_ref`,
    [supportId]
  );
  return rows.map((row) => (row as { extraction_ref: string }).extraction_ref);
}

export async function readScopeRevisions(
  client: EvidenceClient,
  scopeBinding: string
): Promise<ScopeRevisionRecord | null> {
  const { rows } = await client.query(
    `SELECT scope_binding, authorization_revision, purge_revision
       FROM evidence_scope_revisions WHERE scope_binding = $1`,
    [scopeBinding]
  );
  return rows.length === 0
    ? null
    : toScopeRevisions(rows[0] as Record<string, any>);
}

/** Lock the admission row so a matching fence stays current through the batch. */
export async function lockScopeRevisions(
  client: EvidenceClient,
  scopeBinding: string
): Promise<ScopeRevisionRecord | null> {
  const { rows } = await client.query(
    `SELECT scope_binding, authorization_revision, purge_revision
       FROM evidence_scope_revisions WHERE scope_binding = $1 FOR UPDATE`,
    [scopeBinding]
  );
  return rows.length === 0
    ? null
    : toScopeRevisions(rows[0] as Record<string, any>);
}

/**
 * Publish a scope's revisions. The first write must carry both: a scope
 * admitted with an unknown purge state could never fail closed on a purge, so
 * the validator refuses that request before it reaches this statement.
 */
export async function writeScopeRevisions(
  client: EvidenceClient,
  scopeBinding: string,
  authorizationRevision: string | null,
  purgeRevision: string | null
): Promise<ScopeRevisionRecord> {
  const result =
    authorizationRevision === null || purgeRevision === null
      ? await client.query(
          `UPDATE evidence_scope_revisions
              SET authorization_revision = COALESCE($2, authorization_revision),
                  purge_revision = COALESCE($3, purge_revision)
            WHERE scope_binding = $1
            RETURNING scope_binding, authorization_revision, purge_revision`,
          [scopeBinding, authorizationRevision, purgeRevision]
        )
      : await client.query(
          `INSERT INTO evidence_scope_revisions
             (scope_binding, authorization_revision, purge_revision)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope_binding) DO UPDATE
              SET authorization_revision = EXCLUDED.authorization_revision,
                  purge_revision = EXCLUDED.purge_revision
           RETURNING scope_binding, authorization_revision, purge_revision`,
          [scopeBinding, authorizationRevision, purgeRevision]
        );
  return toScopeRevisions(requireRow(result.rows, "the scope revision write"));
}

/**
 * The shared authorization receipt, joined rather than duplicated: the second
 * count grant admitted under one scope/revision pair gets the first one's row.
 * The no-op UPDATE is the join arm, so one statement both creates and reads.
 */
async function joinAuthorizationReceipt(
  client: EvidenceClient,
  scope: ScopeRevisionRecord,
  receiptId: string,
  createdAt: string
): Promise<AuthorizationReceipt> {
  const { rows } = await client.query(
    `INSERT INTO evidence_authorization_receipts
       (receipt_id, scope_binding, authorization_revision, purge_revision, created_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (scope_binding, authorization_revision, purge_revision)
       DO UPDATE SET receipt_id = evidence_authorization_receipts.receipt_id
     RETURNING ${RECEIPT_COLUMNS}`,
    [
      receiptId,
      scope.scope_binding,
      scope.authorization_revision,
      scope.purge_revision,
      createdAt,
    ]
  );
  return toReceipt(requireRow(rows, "the authorization receipt join"));
}

/** Every fact a replay decision needs, gathered inside the caller's transaction. */
export interface GrantWritePlan {
  readonly grant: NormalizedGrant;
  readonly evidenceRef: string;
  readonly receiptId: string;
}

/**
 * Issue the grant inside the caller's transaction: the shared receipt, the
 * grant row and its pinned dependencies are one write, because a reference
 * without its obligations is an obligation nothing can be checked against.
 *
 * A row dependency is resolved here rather than by the FK, so an unresolvable
 * one is the typed refusal the contract names instead of a constraint
 * violation a caller would have to translate.
 */
export async function issueGrantRows(
  client: EvidenceClient,
  plan: GrantWritePlan
): Promise<EvidenceGrantRecord> {
  const scope = await readScopeRevisions(client, plan.grant.scope_binding);
  if (scope === null) {
    throw evidenceError(
      EVIDENCE_FAILURE.UNAVAILABLE,
      `grant: admission scope "${plan.grant.scope_binding}" has no revisions on record`
    );
  }
  const isCount = plan.grant.kind === EVIDENCE_GRANT_KIND.COUNT;
  const receipt = isCount
    ? await joinAuthorizationReceipt(
        client,
        scope,
        plan.receiptId,
        plan.grant.queried_at
      )
    : null;
  const pinned = await readPinnableDependencies(client, plan.grant);
  const grant = await insertGrantRow(
    client,
    plan,
    scope,
    receipt?.receipt_id ?? null
  );
  await pinGrantDependencies(
    client,
    plan.evidenceRef,
    plan.grant.supports,
    pinned
  );
  return grant;
}

/** One dependency a row grant may protect, with the links it pins. */
interface PinnableDependency {
  readonly support_id: string;
  readonly extraction_ref: string;
}

/**
 * The extraction links a row grant protects, resolved per dependency.
 *
 * A source version that stopped accepting obligations is refused at the write:
 * "no new grant after a purge candidate stops accepting obligations" is a
 * property of the grant, not only of the replay that would later deny it.
 */
async function readPinnableDependencies(
  client: EvidenceClient,
  grant: NormalizedGrant
): Promise<readonly PinnableDependency[]> {
  const pinned: PinnableDependency[] = [];
  for (const ref of grant.supports) {
    const { rows } = await client.query(
      `SELECT s.support_id, v.obligations_stopped_at
         FROM assertion_supports s
         JOIN source_versions v ON v.source_version_id = s.source_version_id
        WHERE s.support_id = $1`,
      [ref.support_id]
    );
    const row = rows[0] as { obligations_stopped_at?: unknown } | undefined;
    if (row === undefined) {
      throw evidenceError(
        EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
        `row grant names support ${ref.support_id}, whose source version binding does not resolve`
      );
    }
    if (
      row.obligations_stopped_at !== null &&
      row.obligations_stopped_at !== undefined
    ) {
      throw evidenceError(
        EVIDENCE_FAILURE.UNAVAILABLE,
        `row grant names support ${ref.support_id}, whose source version stopped accepting obligations at ${isoOrNull(row.obligations_stopped_at)}`
      );
    }
    const links = await readSupportExtractionRefs(client, ref.support_id);
    pinned.push(
      ...links.map((extractionRef) => ({
        support_id: ref.support_id,
        extraction_ref: extractionRef,
      }))
    );
  }
  return pinned;
}

async function insertGrantRow(
  client: EvidenceClient,
  plan: GrantWritePlan,
  scope: ScopeRevisionRecord,
  receiptId: string | null
): Promise<EvidenceGrantRecord> {
  const { rows } = await client.query(
    `INSERT INTO evidence_grants
       (evidence_ref, grant_kind, subject, operation, query_digest, scope_binding,
        read_revision, authorization_revision, purge_revision, queried_at,
        expires_at, context, value, result_count, authorization_receipt_id,
        consumer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz,
             $12::jsonb, $13::jsonb, $14, $15, $16)
     RETURNING ${GRANT_COLUMNS}`,
    [
      plan.evidenceRef,
      plan.grant.kind,
      plan.grant.subject,
      plan.grant.operation,
      plan.grant.query_digest,
      plan.grant.scope_binding,
      plan.grant.read_revision,
      scope.authorization_revision,
      scope.purge_revision,
      plan.grant.queried_at,
      plan.grant.expires_at,
      JSON.stringify(plan.grant.context),
      JSON.stringify(plan.grant.value),
      plan.grant.count,
      receiptId,
      plan.grant.consumer_id,
    ]
  );
  return toGrantRecord(requireRow(rows, "the grant insert"));
}

/**
 * Pin the row grant's obligations. The extraction links are copied per grant
 * on purpose: the grant must protect the dependency set as it stood at query
 * time, so a later extraction cannot silently widen what a historical
 * citation holds.
 */
async function pinGrantDependencies(
  client: EvidenceClient,
  evidenceRef: string,
  supports: readonly EvidenceSupportRef[],
  pinned: readonly PinnableDependency[]
): Promise<void> {
  for (const ref of supports) {
    await client.query(
      `INSERT INTO evidence_grant_supports (evidence_ref, support_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (evidence_ref, support_id) DO NOTHING`,
      [evidenceRef, ref.support_id, ref.role]
    );
  }
  for (const link of pinned) {
    await client.query(
      `INSERT INTO evidence_grant_extractions
         (evidence_ref, support_id, extraction_ref)
       VALUES ($1, $2, $3)
       ON CONFLICT (evidence_ref, support_id, extraction_ref) DO NOTHING`,
      [evidenceRef, link.support_id, link.extraction_ref]
    );
  }
}

export async function readGrantFacts(
  client: EvidenceClient,
  evidenceRef: string
): Promise<GrantReadFacts> {
  const grants = await client.query(
    `SELECT ${GRANT_COLUMNS} FROM evidence_grants WHERE evidence_ref = $1`,
    [evidenceRef]
  );
  if (grants.rows.length === 0) return emptyGrantFacts;
  const grant = toGrantRecord(grants.rows[0] as Record<string, any>);
  const scope = await readScopeRevisions(client, grant.scope_binding);
  const receipt =
    grant.authorization_receipt_id === null
      ? null
      : await readReceiptRow(client, grant.authorization_receipt_id);
  const pinned = await readPinnedDependencyCount(client, evidenceRef);
  return {
    grant,
    scope,
    receipt,
    dependencies: await readGrantDependencies(client, evidenceRef),
    pinned,
  };
}

const emptyGrantFacts: GrantReadFacts = {
  grant: null,
  scope: null,
  receipt: null,
  dependencies: [],
  pinned: 0,
};

async function readReceiptRow(
  client: EvidenceClient,
  receiptId: string
): Promise<AuthorizationReceipt | null> {
  const { rows } = await client.query(
    `SELECT ${RECEIPT_COLUMNS} FROM evidence_authorization_receipts
      WHERE receipt_id = $1`,
    [receiptId]
  );
  return rows.length === 0 ? null : toReceipt(rows[0] as Record<string, any>);
}

/** How many dependencies the grant pinned, read from the grant's own table. */
async function readPinnedDependencyCount(
  client: EvidenceClient,
  evidenceRef: string
): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS total FROM evidence_grant_supports
      WHERE evidence_ref = $1`,
    [evidenceRef]
  );
  return Number((rows[0] as { total: number } | undefined)?.total ?? 0);
}

/**
 * The retained dependency set with each source version's obligation stamp.
 *
 * The INNER JOINs are the indivisibility rule: a support whose source version
 * no longer resolves yields no row here, and a snapshot with fewer
 * dependencies than it pinned is withheld rather than partially rendered.
 */
async function readGrantDependencies(
  client: EvidenceClient,
  evidenceRef: string
): Promise<readonly GrantDependencyFact[]> {
  const { rows } = await client.query(
    `SELECT ${QUALIFIED_SUPPORT_COLUMNS}, g.role, v.obligations_stopped_at
       FROM evidence_grant_supports g
       JOIN assertion_supports s ON s.support_id = g.support_id
       JOIN source_versions v ON v.source_version_id = s.source_version_id
      WHERE g.evidence_ref = $1
      ORDER BY s.support_id`,
    [evidenceRef]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, any>;
    return {
      role: row.role as GrantDependencyFact["role"],
      support: toSupportRecord(row),
      obligations_stopped_at: isoOrNull(row.obligations_stopped_at),
    };
  });
}

/**
 * Stamp one lifecycle fact on a source version. Every stamp is a data
 * revision except `obligations_stopped_at`, which is what a purge candidate
 * uses to refuse new obligations.
 */
export async function stampSourceVersionRow(
  client: EvidenceClient,
  stamp: SourceVersionStamp,
  sourceVersionId: string,
  at: string
): Promise<void> {
  const { rows } = await client.query(
    `${STAMP_SQL[stamp]} WHERE source_version_id = $1 RETURNING source_version_id`,
    [sourceVersionId, instantText(at, stamp)]
  );
  if (rows.length === 0) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `evidence store: cannot stamp ${stamp} on unknown source version ${sourceVersionId}`
    );
  }
}

/**
 * One statement shape for the grant's pinned extraction links. Passing
 * `supportIds` pushes the membership filter into PostgreSQL; omitting it
 * returns the whole grant. Reading `evidence_grant_extractions` rather than
 * `support_extractions` is what keeps a later extraction from widening what a
 * read says about a historical citation.
 */
async function selectGrantPinnedExtractions(
  client: EvidenceClient,
  evidenceRef: string,
  supportIds: readonly string[] | null
): Promise<Array<{ support_id: string; extraction_ref: string }>> {
  const { rows } =
    supportIds === null
      ? await client.query(
          `SELECT support_id, extraction_ref FROM evidence_grant_extractions
            WHERE evidence_ref = $1 ORDER BY support_id, extraction_ref`,
          [evidenceRef]
        )
      : await client.query(
          `SELECT support_id, extraction_ref FROM evidence_grant_extractions
            WHERE evidence_ref = $1 AND support_id = ANY($2::uuid[])
            ORDER BY support_id, extraction_ref`,
          [evidenceRef, [...supportIds]]
        );
  return rows as Array<{ support_id: string; extraction_ref: string }>;
}

/** The extraction links a row grant pinned at issue time. */
export async function readGrantPinnedExtractions(
  client: EvidenceClient,
  evidenceRef: string
): Promise<Array<{ support_id: string; extraction_ref: string }>> {
  return selectGrantPinnedExtractions(client, evidenceRef, null);
}

/**
 * The pinned extraction links of the named supports only, keyed by support id
 * with an empty list for a support that pinned none.
 */
export async function readGrantPinnedExtractionsForSupports(
  client: EvidenceClient,
  evidenceRef: string,
  supportIds: readonly string[]
): Promise<ReadonlyMap<string, readonly string[]>> {
  const bySupport = new Map<string, string[]>(supportIds.map((id) => [id, []]));
  if (supportIds.length === 0) return bySupport;
  for (const row of await selectGrantPinnedExtractions(
    client,
    evidenceRef,
    supportIds
  )) {
    bySupport.get(row.support_id)?.push(row.extraction_ref);
  }
  return bySupport;
}

/** Which support ids a grant names, with the reason it holds each. */
export async function readGrantDependenciesByRef(
  client: EvidenceClient,
  evidenceRef: string
): Promise<readonly GrantDependencyFact[]> {
  return readGrantDependencies(client, evidenceRef);
}
