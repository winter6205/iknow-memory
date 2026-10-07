/** Evidence source/support/grant tables and indexes. */
import {
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../types.js";
import {
  sqlTextList,
  sqlTextLiteral,
  type SchemaBootstrapClient,
} from "./schema-sql.js";

const EVIDENCE_SUBJECT_KIND_VALUES: readonly string[] = Object.values(
  EVIDENCE_SUBJECT_KIND
);
const EVIDENCE_GRANT_KIND_VALUES: readonly string[] =
  Object.values(EVIDENCE_GRANT_KIND);
const EVIDENCE_SUPPORT_ROLE_VALUES: readonly string[] = Object.values(
  EVIDENCE_SUPPORT_ROLE
);

/**
 * The immutable source/support records and the finite grants
 * (specs/structured-corpus-evidence.md).
 *
 * Separate from `source_documents` on purpose: that table is a mutable prose
 * SoR keyed by one locator, and none of these facts can live there. A source
 * version is immutable and versioned, a support keeps every origin instead of
 * the single `triples.source_chunk_id` the dedup path allows, and a grant has
 * a fixed deadline. Retrofitting any of them into the legacy tables would
 * make their mutability the reason an obligation could not be kept.
 *
 * `span_start`/`span_end` use the -1 spelling for an absent span instead of
 * NULL so occurrence identity is one plain UNIQUE constraint rather than an
 * expression index: NULLs never collide in a unique constraint, so NULL
 * columns would let the same absent-span occurrence become many supports.
 */
export async function createEvidenceTables(
  client: SchemaBootstrapClient
): Promise<void> {
  await createSourceVersions(client);
  await createSourceVersionLocators(client);
  await createAssertionSupports(client);
  await createSupportExtractions(client);
  await createEvidenceScopeRevisions(client);
  await createAuthorizationReceipts(client);
  await createEvidenceGrants(client);
  await createEvidenceGrantSupports(client);
  await createEvidenceGrantExtractions(client);
}

async function createSourceVersions(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS source_versions (
      source_version_id      uuid PRIMARY KEY,
      source_ref             text NOT NULL,
      source_version         text NOT NULL,
      content_digest         text NOT NULL,
      origin_object_ref      text NOT NULL,
      parser_revision        text NOT NULL,
      unit_manifest          jsonb NOT NULL,
      created_at             timestamptz NOT NULL,
      retired_at             timestamptz NULL,
      payload_collected_at   timestamptz NULL,
      obligations_stopped_at timestamptz NULL
    )`);
  // One version key per logical source. Reuse across two sources would let the
  // same version name mean different content, which is why this is a
  // two-column key and not a unique source_version alone.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS source_versions_source_ref_source_version_idx
      ON source_versions (source_ref, source_version)`);
}

async function createSourceVersionLocators(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS source_version_locators (
      source_version_id uuid NOT NULL
        REFERENCES source_versions(source_version_id) ON DELETE CASCADE,
      document_id       text NOT NULL,
      unit_version      text NOT NULL,
      unit              integer NOT NULL CHECK (unit >= 1),
      CONSTRAINT source_version_locators_binding_key
        PRIMARY KEY (source_version_id, document_id, unit_version, unit)
    )`);
}

async function createAssertionSupports(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS assertion_supports (
      support_id        uuid PRIMARY KEY,
      subject           text NOT NULL,
      result_id         text NOT NULL,
      source_ref        text NOT NULL,
      source_version    text NOT NULL,
      source_version_id uuid NOT NULL
        REFERENCES source_versions(source_version_id) ON DELETE RESTRICT,
      document_id       text NOT NULL,
      unit_version      text NOT NULL,
      unit              integer NOT NULL CHECK (unit >= 1),
      span_start        integer NOT NULL DEFAULT -1,
      span_end          integer NOT NULL DEFAULT -1,
      created_at        timestamptz NOT NULL,
      CONSTRAINT assertion_supports_subject_check
        CHECK (subject IN (${sqlTextList(EVIDENCE_SUBJECT_KIND_VALUES)})),
      CONSTRAINT assertion_supports_occurrence_key
        UNIQUE (subject, result_id, source_ref, source_version, document_id,
                unit_version, unit, span_start, span_end),
      CONSTRAINT assertion_supports_span_check
        CHECK ((span_start = -1 AND span_end = -1)
            OR (span_start >= 0 AND span_end > span_start))
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS assertion_supports_source_version_idx
      ON assertion_supports (source_version_id)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS assertion_supports_result_idx
      ON assertion_supports (subject, result_id)`);
}

async function createSupportExtractions(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_extractions (
      support_id     uuid NOT NULL
        REFERENCES assertion_supports(support_id) ON DELETE CASCADE,
      extraction_ref text NOT NULL,
      created_at     timestamptz NOT NULL,
      CONSTRAINT support_extractions_link_key PRIMARY KEY (support_id, extraction_ref)
    )`);
  // The accepted-occurrence membership read filters by extraction revision,
  // not by support, so the index is on the revision side.
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_extractions_extraction_ref_idx
      ON support_extractions (extraction_ref)`);
}

async function createEvidenceScopeRevisions(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_scope_revisions (
      scope_binding          text PRIMARY KEY,
      authorization_revision text NOT NULL,
      purge_revision         text NOT NULL
    )`);
}

async function createAuthorizationReceipts(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_authorization_receipts (
      receipt_id             uuid PRIMARY KEY,
      scope_binding          text NOT NULL,
      authorization_revision text NOT NULL,
      purge_revision         text NOT NULL,
      created_at             timestamptz NOT NULL
    )`);
  // The share key: every count reference admitted under one scope/revision
  // pair replays against this one row instead of a copy per reference.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS evidence_authorization_receipts_scope_revisions_idx
      ON evidence_authorization_receipts
        (scope_binding, authorization_revision, purge_revision)`);
}

async function createEvidenceGrants(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_grants (
      evidence_ref             text PRIMARY KEY,
      grant_kind               text NOT NULL,
      subject                  text NOT NULL,
      operation                text NOT NULL,
      query_digest             text NOT NULL,
      scope_binding            text NOT NULL,
      read_revision            text NOT NULL,
      authorization_revision   text NOT NULL,
      purge_revision           text NOT NULL,
      queried_at               timestamptz NOT NULL,
      expires_at               timestamptz NOT NULL,
      context                  jsonb NOT NULL,
      value                    jsonb NOT NULL,
      result_count             integer NULL,
      -- Which per-consumer stream this grant belongs to, so its eventual
      -- invalidation has a stream to be published on (ADR 0097 §2.1,
      -- register §1b.3).
      consumer_id              text NOT NULL DEFAULT '',
      authorization_receipt_id uuid NULL
        REFERENCES evidence_authorization_receipts(receipt_id) ON DELETE RESTRICT,
      CONSTRAINT evidence_grants_kind_check
        CHECK (grant_kind IN (${sqlTextList(EVIDENCE_GRANT_KIND_VALUES)})),
      CONSTRAINT evidence_grants_subject_check
        CHECK (subject IN (${sqlTextList(EVIDENCE_SUBJECT_KIND_VALUES)})),
      CONSTRAINT evidence_grants_count_check
        CHECK (result_count IS NULL OR result_count >= 0),
      -- A count grant is a receipt plus a shared authorization receipt and
      -- nothing else, so the storage refuses a count that also names
      -- dependencies or a row that carries a count.
      CONSTRAINT evidence_grants_arm_check
        CHECK ((grant_kind = ${sqlTextLiteral(EVIDENCE_GRANT_KIND.COUNT)}
                AND result_count IS NOT NULL
                AND authorization_receipt_id IS NOT NULL)
            OR (grant_kind = ${sqlTextLiteral(EVIDENCE_GRANT_KIND.ROW)}
                AND result_count IS NULL
                AND authorization_receipt_id IS NULL))
    )`);
  // Forward-compat ALTER for `consumer_id`, and the reason a table that
  // ALREADY SHIPS differs from one that does not.
  //
  // `evidence_grants` is not a new table: it was created by commit a932d5c, so
  // every deployed store already has it, and `CREATE TABLE IF NOT EXISTS`
  // against an existing table is a no-op — it never compares columns. A column
  // that exists only in the CREATE therefore reaches brand-new stores and
  // nothing else, and every grant issuance on a deployed store dies with
  // SQLSTATE 42703. `evidence_invalidation_outbox` and
  // `evidence_invalidation_cursors` DO need no ALTER, because they are probed in
  // BOOTSTRAP_TABLES: their absence keeps the probe answering "not ready", which
  // is what makes the bootstrap replay their CREATE at all. `evidence_grants` is
  // probed as a TABLE too, so the probe answered ready on exactly the stores
  // that lacked the column, and the replay that would have fixed it never ran.
  //
  // The pair (`["evidence_grants", "consumer_id"]`) in BOOTSTRAP_COLUMNS is
  // therefore not optional bookkeeping: `upSchemaBootstrap` short-circuits the
  // entire DDL block when the probe says ready, so without it this ALTER is dead
  // code on every deployed database. tests/storage/bootstrap-columns.test.ts
  // derives the probe's contents from the ALTERs emitted here, so the two cannot
  // drift.
  //
  // `DEFAULT ''` is for rows that predate the column, which have no consumer
  // because the grant was issued before invalidation streams existed. They are
  // NOT trusted: an empty consumer is refused at issuance (`assertFilled` in
  // evidence-store.ts), and the cursor a new event is published on can never be
  // an empty one, so a backfilled row cannot receive an invalidation nobody
  // drains. Without the default the ALTER would need a nullable column plus a
  // later backfill, and NOT NULL is the property that makes the "no stream" case
  // impossible to store silently.
  await client.query(`
    ALTER TABLE evidence_grants
      ADD COLUMN IF NOT EXISTS consumer_id text NOT NULL DEFAULT ''`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS evidence_grants_expires_at_idx
      ON evidence_grants (expires_at)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS evidence_grants_scope_binding_idx
      ON evidence_grants (scope_binding)`);
}

async function createEvidenceGrantSupports(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_grant_supports (
      evidence_ref text NOT NULL
        REFERENCES evidence_grants(evidence_ref) ON DELETE CASCADE,
      support_id   uuid NOT NULL
        REFERENCES assertion_supports(support_id) ON DELETE RESTRICT,
      role         text NOT NULL,
      CONSTRAINT evidence_grant_supports_dependency_key
        PRIMARY KEY (evidence_ref, support_id),
      CONSTRAINT evidence_grant_supports_role_check
        CHECK (role IN (${sqlTextList(EVIDENCE_SUPPORT_ROLE_VALUES)}))
    )`);
  // The collector asks which unexpired grants hold one support, so the index
  // is on the support side.
  await client.query(`
    CREATE INDEX IF NOT EXISTS evidence_grant_supports_support_id_idx
      ON evidence_grant_supports (support_id)`);
}

async function createEvidenceGrantExtractions(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_grant_extractions (
      evidence_ref   text NOT NULL
        REFERENCES evidence_grants(evidence_ref) ON DELETE CASCADE,
      support_id     uuid NOT NULL,
      extraction_ref text NOT NULL,
      CONSTRAINT evidence_grant_extractions_pinned_key
        PRIMARY KEY (evidence_ref, support_id, extraction_ref),
      -- RESTRICT, not CASCADE: a grant protects the extraction set it was
      -- issued against, so dropping a link out from under a live grant would
      -- silently shrink a historical citation's dependencies.
      CONSTRAINT evidence_grant_extractions_link_fk
        FOREIGN KEY (support_id, extraction_ref)
      REFERENCES support_extractions(support_id, extraction_ref)
        ON DELETE RESTRICT
    )`);
}
