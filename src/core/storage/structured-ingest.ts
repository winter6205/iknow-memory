import { createHash, randomUUID } from "node:crypto";

import {
  evidenceError,
  normalizeLocatorBinding,
  normalizeOccurrence,
  normalizeSourceVersion,
  supportOccurrenceKey,
} from "./evidence-source.js";
import {
  bindSourceLocatorRow,
  recordSupportRow,
  registerSourceVersionRow,
} from "./evidence-pg.js";
import { EVIDENCE_FAILURE } from "../types.js";
import type { EvidenceClient } from "./evidence-store.js";
import type {
  EvidenceSpan,
  NewSourceVersion,
  SourceLocatorBinding,
  SourceVersionRecord,
  SupportRecord,
} from "../types.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeRunOptions,
  AuthorizedScopeWork,
} from "./structured-scope-types.js";

export interface StructuredIngestAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: AuthorizedScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

export interface StructuredIngestLocator {
  readonly document_id: string;
  readonly version: string;
  readonly unit: number;
  readonly sourceVersionId?: string;
}

export interface StructuredIngestOccurrence {
  readonly subject: "entity" | "assertion";
  readonly resultId: string;
  readonly location: StructuredIngestLocator;
  readonly span?: EvidenceSpan | null;
  readonly extractionRef: string;
  readonly extractedAt: string;
}

export interface StructuredIngestRequest {
  readonly sourceVersion: NewSourceVersion;
  readonly locators: readonly StructuredIngestLocator[];
  readonly occurrences: readonly StructuredIngestOccurrence[];
}

export interface StructuredIngestOutcome {
  readonly sourceVersion: SourceVersionRecord;
  readonly sourceVersionCreated: boolean;
  readonly locators: readonly SourceLocatorBinding[];
  readonly supports: readonly {
    readonly support: SupportRecord;
    readonly created: boolean;
    readonly occurrenceKey: string;
  }[];
}

const DECLARING_RUN: AuthorizedScopeRunOptions = { authorizeNewSources: true };

/**
 * Frozen RFC 4122 namespace for the occurrence→support-id derivation. It is a
 * one-way door: `recordSupportRow` conflicts on the occurrence key rather than
 * on `support_id`, so changing this value re-derives every support id while no
 * insert fails, and `assertion_supports` would silently split into two disjoint
 * id spaces that no stored column could tell apart.
 *
 * PROVISIONAL, not frozen: ticket T12 (QP10) freezes post-ingest
 * backend-assigned identifiers and records the agreed value here. Until T12
 * lands this constant is pending its one-way-door decision.
 */
export const SUPPORT_ID_NAMESPACE = "6f6b1c2e-9a4d-5f38-b7c1-0d2e3f4a5b6c";

const asEvidenceClient = (
  client: AuthorizedScopeWork["client"]
): EvidenceClient => client;

function bindingFor(
  locator: StructuredIngestLocator,
  sourceVersionId: string
): SourceLocatorBinding {
  if (
    locator.sourceVersionId !== undefined &&
    locator.sourceVersionId !== sourceVersionId
  ) {
    // EXIT: a locator whose `sourceVersionId` is present and differs from the
    // source version this run just registered throws
    // `unsupported_source_binding`; the unit of work rolls back, so no source
    // version, locator binding or support from this run is committed.
    throw evidenceError(
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      `locator ${locator.document_id}/${locator.version}/${locator.unit} names source version ${locator.sourceVersionId}, but this run registers ${sourceVersionId}`
    );
  }
  return normalizeLocatorBinding({
    source_version_id: sourceVersionId,
    document_id: locator.document_id,
    version: locator.version,
    unit: locator.unit,
  });
}

function requireDeclaredSourcesAuthorized(
  context: AuthorizedScopeContext,
  request: StructuredIngestRequest
): void {
  const authorized = new Set(context.authorizedSourceRefs);
  const sourceRef = request.sourceVersion.source_ref;
  if (authorized.has(sourceRef)) return;
  // EXIT: a request whose source version names a `source_ref` absent from the
  // context's `authorizedSourceRefs` throws `access_denied` before the unit of
  // work opens; no statement has run, so no row of this run is written.
  throw evidenceError(
    EVIDENCE_FAILURE.ACCESS_DENIED,
    `source ${sourceRef} is outside the trusted authorized set of this run`
  );
}

const IDENTITY_SUBJECT_TABLE = {
  assertion: ["structured_relation_assertion_identities", "assertion_id"],
  entity: ["structured_entity_identities", "entity_id"],
} as const;

async function requireRegisteredResultIdentity(
  client: EvidenceClient,
  occurrence: StructuredIngestOccurrence
): Promise<void> {
  const [table, column] = IDENTITY_SUBJECT_TABLE[occurrence.subject];
  const { rows } = await client.query(
    `SELECT 1 AS present FROM ${table} WHERE ${column}::text = $1`,
    [occurrence.resultId]
  );
  if (rows.length > 0) return;
  // EXIT: an occurrence whose `resultId` names no registered QP3 identity of
  // its own subject throws `unsupported_source_binding`. The unit of work rolls
  // back, so no support citing the dangling reference is committed —
  // `assertion_supports.result_id` carries no foreign key, so this write-side
  // check is the only thing standing between a caller and a persisted
  // reference no identity row backs. The closed scope code set has no distinct
  // token for an unresolved identity reference, so the unresolved-binding
  // token is used rather than widening that set.
  throw evidenceError(
    EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
    `occurrence ${occurrence.extractionRef} names ${occurrence.subject} identity ${occurrence.resultId}, which is not registered`
  );
}

export async function ingestStructuredSource(
  authority: StructuredIngestAuthority,
  context: AuthorizedScopeContext,
  request: StructuredIngestRequest
): Promise<StructuredIngestOutcome> {
  requireDeclaredSourcesAuthorized(context, request);
  return authority.withAuthorizedScope(
    context,
    async (work) => {
      const client = asEvidenceClient(work.client);
      const plan = normalizeSourceVersion(request.sourceVersion);
      const version = await registerSourceVersionRow(client, {
        ...plan,
        source_version_id: plan.source_version_id || randomUUID(),
      });
      const sourceVersionId = version.record.source_version_id;

      const locators: SourceLocatorBinding[] = [];
      for (const locator of request.locators) {
        locators.push(
          await bindSourceLocatorRow(
            client,
            bindingFor(locator, sourceVersionId)
          )
        );
      }

      const supports: {
        support: SupportRecord;
        created: boolean;
        occurrenceKey: string;
      }[] = [];
      for (const occurrence of request.occurrences) {
        await requireRegisteredResultIdentity(client, occurrence);
        const support = normalizeOccurrence({
          subject: occurrence.subject,
          result_id: occurrence.resultId,
          source_ref: request.sourceVersion.source_ref,
          source_version: request.sourceVersion.source_version,
          location: occurrence.location,
          span: occurrence.span ?? null,
          extraction_ref: occurrence.extractionRef,
          extractedAt: occurrence.extractedAt,
        });
        const supportId = supportIdOf(support);
        const recorded = await recordSupportRow(client, support, supportId);
        supports.push({
          support: recorded.support,
          created: recorded.created,
          occurrenceKey: supportOccurrenceKey(support),
        });
      }

      return {
        sourceVersion: version.record,
        sourceVersionCreated: version.created,
        locators,
        supports,
      };
    },
    DECLARING_RUN
  );
}

function supportIdOf(support: {
  readonly subject: string;
  readonly result_id: string;
  readonly source_ref: string;
  readonly source_version: string;
  readonly location: {
    readonly document_id: string;
    readonly version: string;
    readonly unit: number;
  };
  readonly span: EvidenceSpan | null;
}): string {
  const key = supportOccurrenceKey(
    support as Parameters<typeof supportOccurrenceKey>[0]
  );
  return uuidV5(SUPPORT_ID_NAMESPACE, key);
}

function uuidV5(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
