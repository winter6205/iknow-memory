import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EntityIdentityInput } from "../../src/core/structured/identity-store.js";
import { PgStructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import type { StructuredPublicationStorage } from "../../src/core/maintenance/publication-types.js";
import {
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";
import type { EvidenceSupportRef } from "../../src/core/types.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  inEvidenceTransaction,
  issueGrantRows,
} from "../../src/core/storage/evidence-pg.js";
import type { NormalizedGrant } from "../../src/core/storage/evidence-store.js";
import { ingestStructuredSource } from "../../src/core/storage/structured-ingest.js";
import type {
  StructuredIngestLocator,
  StructuredIngestOccurrence,
  StructuredIngestRequest,
} from "../../src/core/storage/structured-ingest.js";
import type { PgStructuredScopeUnitOfWork } from "../../src/core/storage/structured-scope-uow.js";
import type { AuthorizedScopeContextInput } from "../../src/core/storage/structured-scope-types.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "STRUCTURED_INGEST_ACCEPTANCE=1 STRUCTURED_INGEST_ORACLE_DIR=<approved-packet-dir> GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-ingest-pg.test.ts";
const ACCEPTANCE_ENV = "STRUCTURED_INGEST_ACCEPTANCE";
const ORACLE_DIR_ENV = "STRUCTURED_INGEST_ORACLE_DIR";
const SCHEMA_PREFIX = "structured_ingest_acceptance";
const ORACLE_FILE = "oracle.json";
const SOURCES_FILE = "sources.json";
const UNITS_DIR = "units";
const UNITS_MANIFEST_FILE = `${UNITS_DIR}/manifest.json`;
const APPROVED_ORACLE_FORMAT = "structured-knowledge-oracle-candidate-v1";
const APPROVED_UNITS_FORMAT = "structured-corpus-frozen-units-v2";
const APPROVED_ORACLE_STATUS = "approved";
const INGESTED_SOURCE_ID = "k8s-sig-list-v2";
const DIMENSIONS = 8;
const ACTOR = "structured-ingest-trusted-owner";
const READER = "structured-ingest-reader";
const AUTHORIZATION_REVISION = "ingest-auth-1";
const CREATED_AT = "2026-10-06T02:11:00Z";
const EXTRACTED_AT = "2026-10-06T02:20:00Z";
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKEND_IDENTIFIER_FREEZE_OWNER = "T12 (QP10)";
const UNIT_ORDINAL_DECISION =
  "Fin-side `unit` is the 1-based ordinal of the unit in units/manifest.json order for this source. The approved packet supplies line ranges rather than an ordinal, so this mapping is a recorded T08 decision, not an oracle-derived value; the locator assertion below is a round-trip of it.";
const UNIT_TEXT_LENGTH_SCOPE =
  "This asserts only that each unit text this driver slices is exactly as long, in codepoints, as units/manifest.json declares for it, so a shifted or truncated unit cannot silently re-map every span taken from it. It says nothing about whether the unit text is the correct text for the source; the codepoint_length is itself a claim of the same packet the spans come from.";
const SPAN_SUBJECT_OBJECT_SCOPE =
  "This asserts only that every approved fact's own span, cut from the frozen original unit text, literally contains that fact's own head and tail canonical name. It does NOT assert that these are the only true facts in that text, that the relation between the two names is correct, or that the extraction which produced the packet found what it should have: a packet could name a wrong head whose text happens to sit inside the same span, and a fact that is true but absent from the packet would not be reported at all. What it rules out is a fact whose span does not mention the subject and object the packet claims for it, which is the failure the rest of this suite cannot see because every other check compares the packet against itself.";
const UNIT_MANIFEST_READBACK_SCOPE =
  "This asserts only that source_versions.unit_manifest persisted every field of every unit that units/manifest.json declares for the ingested source, read back from the database rather than from the request object that wrote it. It does not assert the manifest is the complete set of units that exist for the source; a unit the packet omits is invisible here.";

if (process.env[ACCEPTANCE_ENV] !== "1") {
  // EXIT: the strict acceptance marker is absent, empty, or not `1`. The module
  // load throws before the oracle packet, harness, probe or schema exists, so
  // the run exits non-zero naming the absent flag instead of reporting a
  // skipped lane.
  throw new Error(
    [
      `${ACCEPTANCE_ENV}=1 is required to run this acceptance driver.`,
      "Validation:",
      "- Not run: tests/acceptance/structured-ingest-pg.test.ts",
      `- Expected command: ${EXPECTED_COMMAND}`,
      "- Blocking issue: the strict flag is absent, so PostgreSQL evidence would be skipped.",
      "- This driver deliberately has no skip path: a skipped acceptance run is not evidence.",
    ].join("\n")
  );
}

interface PacketSource {
  readonly source_id: string;
  readonly immutable_version_or_capture: string;
  readonly original_asset: string;
  readonly raw_sha256: string;
}

interface PacketSources {
  readonly sources: readonly PacketSource[];
}

interface PacketUnit {
  readonly source_id: string;
  readonly unit_id: string;
  readonly file: string;
  readonly parser_revision: string;
  readonly locator: {
    readonly original_line_ranges_1_based_inclusive: readonly (readonly number[])[];
  };
  readonly codepoint_length: number;
  readonly unit_sha256: string;
}

interface PacketUnitsManifest {
  readonly format: string;
  readonly html_parser_revision: string;
  readonly units: readonly PacketUnit[];
}

interface PacketSupport {
  readonly source_id: string;
  readonly unit_id: string;
  readonly span: {
    readonly unit_codepoint_start: number;
    readonly unit_codepoint_end_exclusive: number;
  };
}

interface PacketFact {
  readonly fact_key: string;
  readonly head: { readonly type: string; readonly canonical_name: string };
  readonly relation_norm: string;
  readonly tail: { readonly type: string; readonly canonical_name: string };
  readonly supports: readonly PacketSupport[];
}

interface PacketOracle {
  readonly format: string;
  readonly status: string;
  readonly method: { readonly backend_query_or_ids_used: boolean };
  readonly facts: readonly PacketFact[];
  readonly dataset_report: {
    readonly relation_norm_counts: Readonly<Record<string, number>>;
  };
}

interface ApprovedFact {
  readonly factKey: string;
  readonly headName: string;
  readonly headType: string;
  readonly relationNorm: string;
  readonly tailName: string;
  readonly tailType: string;
  readonly unitId: string;
  readonly unitNumber: number;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly extractionRef: string;
}

interface ApprovedPacket {
  readonly oracleFormat: string;
  readonly oracleStatus: string;
  readonly backendQueryOrIdsUsed: boolean;
  readonly unitsFormat: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly contentDigest: string;
  readonly originObjectRef: string;
  readonly sourceParserRevision: string;
  readonly unitIds: readonly string[];
  readonly units: readonly PacketUnit[];
  readonly unitParserRevisions: Readonly<Record<string, string>>;
  readonly unitCodepointLengths: Readonly<Record<string, number>>;
  readonly unitTextCodepoints: Readonly<Record<string, readonly string[]>>;
  readonly facts: readonly ApprovedFact[];
  readonly relationNormCounts: Readonly<Record<string, number>>;
}

interface SupportResolutionRow {
  readonly result_id: string;
  readonly document_id: string;
  readonly unit: number;
  readonly span_start: number;
  readonly span_end: number;
  readonly head_name: string;
  readonly relation_norm: string;
  readonly tail_name: string;
}

function oracleDir(): string {
  const dir = process.env[ORACLE_DIR_ENV];
  if (dir === undefined || dir.trim() === "") {
    // EXIT: the approved oracle packet directory is absent or empty. The module
    // load throws before any harness, probe or schema exists, so no baked-in
    // expectation can be used in place of the packet and the run exits
    // non-zero naming the absent variable.
    throw new Error(
      [
        `${ORACLE_DIR_ENV} is required to run this acceptance driver.`,
        "Validation:",
        "- Not run: tests/acceptance/structured-ingest-pg.test.ts",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${ORACLE_DIR_ENV} is ${
          dir === undefined ? "absent" : "present but empty"
        }, so the approved oracle packet cannot be read and no expectation below is derivable.`,
        "- This driver deliberately has no fallback: a hardcoded expectation in place of the approved packet is not evidence.",
      ].join("\n")
    );
  }
  return dir;
}

function readPacketFile(fileName: string): string {
  const text = readFileSafe(join(oracleDir(), fileName));
  if (text === null) {
    // EXIT: the packet file named by `readPacketFile` is missing or unreadable
    // at the directory `ORACLE_DIR_ENV` names. The module load throws before
    // any harness, probe or schema exists, so the run exits non-zero instead of
    // falling back to hardcoded constants.
    throw new Error(
      [
        `${ORACLE_DIR_ENV} does not contain a readable ${fileName}.`,
        "Validation:",
        "- Not run: tests/acceptance/structured-ingest-pg.test.ts",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${fileName} could not be read from the directory named by ${ORACLE_DIR_ENV}.`,
        "- This driver deliberately has no fallback: a hardcoded expectation in place of the approved packet is not evidence.",
      ].join("\n")
    );
  }
  return text;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readUnitText(unit: PacketUnit): readonly string[] {
  const text = readFileSafe(join(oracleDir(), UNITS_DIR, unit.file));
  if (text === null) {
    // EXIT: the frozen original unit text that `units/manifest.json` names for an
    // ingested unit is missing or unreadable. The module load throws before any
    // harness, probe or schema exists, so the span checks below cannot run
    // against a shorter, shifted or substituted unit.
    throw new Error(
      [
        `${ORACLE_DIR_ENV} does not contain a readable ${join(UNITS_DIR, unit.file)} for unit ${unit.unit_id}.`,
        "Validation:",
        "- Not run: tests/acceptance/structured-ingest-pg.test.ts",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: unit ${unit.unit_id} names file ${unit.file}, which could not be read from the directory named by ${ORACLE_DIR_ENV}.`,
        "- This driver deliberately has no fallback: a span checked against text other than the frozen original text is not evidence.",
      ].join("\n")
    );
  }
  return Array.from(text);
}

function readPacketJson<T>(fileName: string): T {
  const text = readPacketFile(fileName);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    // EXIT: the packet file is present but is not valid JSON. The module load
    // throws before any harness, probe or schema exists, so a malformed packet
    // cannot yield a partially-derived expectation set.
    throw new Error(
      [
        `${fileName} in the directory named by ${ORACLE_DIR_ENV} is not valid JSON.`,
        "Validation:",
        "- Not run: tests/acceptance/structured-ingest-pg.test.ts",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${error instanceof Error ? error.message : String(error)}`,
        "- This driver deliberately has no fallback: a hardcoded expectation in place of the approved packet is not evidence.",
      ].join("\n")
    );
  }
}

function packetRefusal(message: string): never {
  throw new Error(
    [
      `The approved oracle packet cannot yield this driver's expectations: ${message}`,
      "Validation:",
      "- Not run: tests/acceptance/structured-ingest-pg.test.ts",
      `- Expected command: ${EXPECTED_COMMAND}`,
      `- Blocking issue: ${message}`,
      "- This driver deliberately has no fallback: a hardcoded expectation in place of the approved packet is not evidence.",
    ].join("\n")
  );
}

function loadApprovedPacket(): ApprovedPacket {
  const oracle = readPacketJson<PacketOracle>(ORACLE_FILE);
  const sources = readPacketJson<PacketSources>(SOURCES_FILE);
  const manifest = readPacketJson<PacketUnitsManifest>(UNITS_MANIFEST_FILE);

  if (oracle.format !== APPROVED_ORACLE_FORMAT) {
    packetRefusal(`oracle.json format is ${oracle.format}`);
  }
  if (manifest.format !== APPROVED_UNITS_FORMAT) {
    packetRefusal(`units/manifest.json format is ${manifest.format}`);
  }
  if (oracle.status !== APPROVED_ORACLE_STATUS) {
    packetRefusal(`oracle.json status is ${oracle.status}`);
  }
  if (oracle.method.backend_query_or_ids_used !== false) {
    packetRefusal(
      "oracle.json method.backend_query_or_ids_used is not false, so the packet is not the independent oracle this driver requires"
    );
  }

  const source = sources.sources.find(
    (entry) => entry.source_id === INGESTED_SOURCE_ID
  );
  if (source === undefined) {
    packetRefusal(`sources.json has no source_id ${INGESTED_SOURCE_ID}`);
  }

  const units = manifest.units.filter(
    (unit) => unit.source_id === source.source_id
  );
  if (units.length === 0) {
    packetRefusal(`units/manifest.json has no unit for ${INGESTED_SOURCE_ID}`);
  }
  const unitNumbers = new Map<string, number>();
  const unitParserRevisions: Record<string, string> = {};
  const unitCodepointLengths: Record<string, number> = {};
  const unitTextCodepoints: Record<string, readonly string[]> = {};
  for (const [index, unit] of units.entries()) {
    unitNumbers.set(unit.unit_id, index + 1);
    unitParserRevisions[unit.unit_id] = unit.parser_revision;
    unitCodepointLengths[unit.unit_id] = unit.codepoint_length;
    unitTextCodepoints[unit.unit_id] = readUnitText(unit);
  }

  const facts: ApprovedFact[] = [];
  for (const fact of oracle.facts) {
    const support = fact.supports.find(
      (entry) => entry.source_id === source.source_id
    );
    if (support === undefined) continue;
    const unitNumber = unitNumbers.get(support.unit_id);
    if (unitNumber === undefined) {
      packetRefusal(
        `fact ${fact.fact_key} names unit ${support.unit_id}, which units/manifest.json does not list for ${source.source_id}`
      );
    }
    facts.push({
      factKey: fact.fact_key,
      headName: fact.head.canonical_name,
      headType: fact.head.type,
      relationNorm: fact.relation_norm,
      tailName: fact.tail.canonical_name,
      tailType: fact.tail.type,
      unitId: support.unit_id,
      unitNumber,
      spanStart: support.span.unit_codepoint_start,
      spanEnd: support.span.unit_codepoint_end_exclusive,
      extractionRef: `t08-${fact.fact_key}`,
    });
  }
  if (facts.length === 0) {
    packetRefusal(
      `oracle.json holds no fact with a support naming ${source.source_id}`
    );
  }

  return {
    oracleFormat: oracle.format,
    oracleStatus: oracle.status,
    backendQueryOrIdsUsed: oracle.method.backend_query_or_ids_used,
    unitsFormat: manifest.format,
    sourceRef: source.source_id,
    sourceVersion: source.immutable_version_or_capture,
    contentDigest: source.raw_sha256,
    originObjectRef: source.original_asset,
    sourceParserRevision: manifest.html_parser_revision,
    unitIds: units.map((unit) => unit.unit_id),
    units,
    unitParserRevisions,
    unitCodepointLengths,
    unitTextCodepoints,
    facts,
    relationNormCounts: oracle.dataset_report.relation_norm_counts,
  };
}

const packet = loadApprovedPacket();
const IDENTITY_TEMPLATE = packet.facts[0];

const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const pgHarness = await createPgIntegrationHarness({
  label: "structured-ingest-acceptance-pg",
  testPath: "tests/acceptance/structured-ingest-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});

const probe = await probePostgres(CONNECTION_STRING, true);
if (!probe.available) {
  // EXIT: PostgreSQL or pgvector is unreachable from GRAPHRAG_MEMORY_DB_URL. The
  // module load throws before the harness-backed suite is collected, so no
  // schema is created and this lane cannot report green.
  throw new Error(
    [
      "Validation:",
      "- Not run: the structured ingest acceptance suite requires real PostgreSQL + pgvector.",
      `- Expected command: ${EXPECTED_COMMAND}`,
      `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
      "- This driver deliberately has no skip path: a skipped acceptance run is not evidence.",
    ].join("\n")
  );
}

const SCHEMA_URL = pgHarness.schemaConnectionString;

function entityUuidFor(canonicalName: string): string {
  const bytes = createHash("sha256")
    .update(`t08-entity:${canonicalName}`, "utf8")
    .digest()
    .subarray(0, 16);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

let backend: PgvectorBackend;
let pool: pg.Pool;
let admin: pg.Client;
let authority: PgStructuredScopeUnitOfWork;
let publication: StructuredPublicationStorage;
let identity: PgStructuredIdentityStore;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function errorCodeOf(error: unknown): string {
  const coded = error as {
    readonly code?: unknown;
    readonly failureToken?: unknown;
  };
  const token = coded?.failureToken;
  if (typeof token === "string") return token;
  const direct = coded?.code;
  if (typeof direct === "string") return direct;
  return "untyped_error";
}

async function codeOf(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return errorCodeOf(error);
  }
}

async function countRows(
  query: string,
  values?: readonly unknown[]
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    query,
    values as unknown[]
  );
  return Number(result.rows[0]?.count ?? "0");
}

function readGrantCount(): Promise<number> {
  return countRows("SELECT count(*)::text AS count FROM evidence_grants");
}

function rowGrantPlan(input: {
  readonly scopeBinding: string;
  readonly readRevision: string;
  readonly queriedAt: string;
  readonly sourceRef: string;
  readonly supports: readonly EvidenceSupportRef[];
}): { grant: NormalizedGrant; evidenceRef: string; receiptId: string } {
  return {
    grant: {
      kind: EVIDENCE_GRANT_KIND.ROW,
      subject: EVIDENCE_SUBJECT_KIND.ASSERTION,
      operation: "structured_assertion_read",
      query_digest: createHash("sha256")
        .update(
          `${input.scopeBinding}|${input.readRevision}|${input.queriedAt}`
        )
        .digest("hex"),
      scope_binding: input.scopeBinding,
      read_revision: input.readRevision,
      queried_at: input.queriedAt,
      expires_at: new Date(
        Date.parse(input.queriedAt) + 365 * 86_400_000
      ).toISOString(),
      context: { actor: ACTOR, source_ref: input.sourceRef },
      value: { source_ref: input.sourceRef },
      supports: input.supports,
      count: null,
    },
    evidenceRef: randomUUID(),
    receiptId: randomUUID(),
  };
}

function context(input: AuthorizedScopeContextInput) {
  return authority.createAuthorizedContext(input);
}

function farDeadline(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

async function admitScope(
  scopeBinding: string,
  authorizationRevision: string
): Promise<void> {
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision,
    purgeRevision: `purge-${authorizationRevision}`,
  });
}

async function seedEntity(
  entityId: string,
  type: string,
  canonicalName: string
): Promise<void> {
  await pool.query(
    `INSERT INTO entities (id, canonical_name, type)
       VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [entityId, canonicalName, type]
  );
}

function approvedLocators(): readonly StructuredIngestLocator[] {
  return packet.unitIds.map((unitId, index) => ({
    document_id: unitId,
    version: packet.sourceVersion,
    unit: index + 1,
  }));
}

function approvedUnitManifest(): Record<string, unknown> {
  return {
    html_parser_revision: packet.sourceParserRevision,
    units: packet.units.map((unit) => ({
      unit_id: unit.unit_id,
      file: unit.file,
      parser_revision: unit.parser_revision,
      locator: unit.locator,
      codepoint_length: unit.codepoint_length,
      unit_sha256: unit.unit_sha256,
    })),
  };
}

function syntheticFact(
  factKey: string,
  unitId: string,
  spanStart: number,
  spanEnd: number
): ApprovedFact {
  return {
    factKey,
    headName: IDENTITY_TEMPLATE.headName,
    headType: IDENTITY_TEMPLATE.headType,
    relationNorm: IDENTITY_TEMPLATE.relationNorm,
    tailName: IDENTITY_TEMPLATE.tailName,
    tailType: IDENTITY_TEMPLATE.tailType,
    unitId,
    unitNumber: 1,
    spanStart,
    spanEnd,
    extractionRef: `extraction-${factKey}`,
  };
}

async function registerFactIdentities(fact: ApprovedFact): Promise<string> {
  const headEntityId = entityUuidFor(fact.headName);
  const tailEntityId = entityUuidFor(fact.tailName);
  await seedEntity(headEntityId, fact.headType, fact.headName);
  await seedEntity(tailEntityId, fact.tailType, fact.tailName);
  const headInput: EntityIdentityInput = {
    entityId: headEntityId,
    type: fact.headType,
  };
  await identity.registerEntity(headInput);
  await identity.registerEntity({
    entityId: tailEntityId,
    type: fact.tailType,
  });
  const registered = await identity.registerRelationAssertion({
    headEntityId,
    relationNorm: fact.relationNorm,
    tailEntityId,
    validWindow: { from: null, until: null },
  });
  return registered.assertionId;
}

function baseRequest(): StructuredIngestRequest {
  return {
    sourceVersion: {
      source_ref: packet.sourceRef,
      source_version: packet.sourceVersion,
      content_digest: packet.contentDigest,
      origin_object_ref: packet.originObjectRef,
      parser_revision: packet.sourceParserRevision,
      unit_manifest: approvedUnitManifest(),
      created_at: CREATED_AT,
      retired_at: null,
      payload_collected_at: null,
      obligations_stopped_at: null,
    },
    locators: approvedLocators(),
    occurrences: [],
  };
}

function supportResolutionKey(input: {
  readonly headName: string;
  readonly relationNorm: string;
  readonly tailName: string;
  readonly unitId: string;
  readonly unitNumber: number;
  readonly spanStart: number;
  readonly spanEnd: number;
}): string {
  return [
    input.headName,
    input.relationNorm,
    input.tailName,
    input.unitId,
    String(input.unitNumber),
    String(input.spanStart),
    String(input.spanEnd),
  ].join("\u0000");
}

function expectedSupportKey(fact: ApprovedFact): string {
  return supportResolutionKey({
    headName: fact.headName,
    relationNorm: fact.relationNorm,
    tailName: fact.tailName,
    unitId: fact.unitId,
    unitNumber: fact.unitNumber,
    spanStart: fact.spanStart,
    spanEnd: fact.spanEnd,
  });
}

function rowSupportKey(row: SupportResolutionRow): string {
  return supportResolutionKey({
    headName: row.head_name,
    relationNorm: row.relation_norm,
    tailName: row.tail_name,
    unitId: row.document_id,
    unitNumber: row.unit,
    spanStart: row.span_start,
    spanEnd: row.span_end,
  });
}

const SUPPORT_RESOLUTION_SQL = `SELECT s.result_id, s.document_id, s.unit, s.span_start, s.span_end,
              h.canonical_name AS head_name, a.relation_norm, t.canonical_name AS tail_name
         FROM assertion_supports s
         JOIN structured_relation_assertion_identities a
           ON a.assertion_id::text = s.result_id
         JOIN entities h ON h.id = a.head_entity_id
         JOIN entities t ON t.id = a.tail_entity_id
        WHERE s.source_ref = $1 AND s.source_version = $2`;

async function readResolvedSupports(
  sourceRef: string,
  sourceVersion: string
): Promise<SupportResolutionRow[]> {
  const result = await pool.query<SupportResolutionRow>(
    SUPPORT_RESOLUTION_SQL,
    [sourceRef, sourceVersion]
  );
  return result.rows;
}

describe("approved structured ingest — PostgreSQL acceptance", () => {
  beforeAll(async () => {
    admin = pgHarness.createClient(SCHEMA_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, {
      annMaxDimensions: 2000,
    });
    await backend.initialize();
    pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 8 });
    const composed = backend as PgvectorBackend & {
      structuredPublication?: StructuredPublicationStorage;
      structuredScopeUnitOfWork?: PgStructuredScopeUnitOfWork;
    };
    const composedAuthority = composed.structuredScopeUnitOfWork;
    const composedPublication = composed.structuredPublication;
    if (!composedAuthority || !composedPublication) {
      // EXIT: the PgvectorBackend composition does not supply the shared
      // authorized-scope unit of work. `beforeAll` throws, so the suite reports
      // a failed setup rather than a lane with no ingest authority under test.
      throw new Error(
        "PgvectorBackend composition must supply the shared authorized scope unit of work to the ingest composition"
      );
    }
    authority = composedAuthority;
    publication = composedPublication;
    identity = new PgStructuredIdentityStore(pool);
  }, 120_000);

  afterAll(async () => {
    try {
      if (!pgHarness.schema.startsWith(`${SCHEMA_PREFIX}_`)) {
        // EXIT: teardown reached a schema this run's own prefix does not name.
        // It throws before the drop, so a schema this run never created is
        // never dropped as if it had.
        throw new Error(
          `refusing to drop a schema outside this run's prefix: ${pgHarness.schema} does not start with ${SCHEMA_PREFIX}_`
        );
      }
      await pgHarness.dropSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  });

  it("derives every expectation from the approved oracle packet at runtime", () => {
    expect(packet.oracleFormat).toBe(APPROVED_ORACLE_FORMAT);
    expect(packet.oracleStatus).toBe(APPROVED_ORACLE_STATUS);
    expect(packet.unitsFormat).toBe(APPROVED_UNITS_FORMAT);
    expect(packet.backendQueryOrIdsUsed).toBe(false);

    const counts = new Map<string, number>();
    for (const fact of packet.facts) {
      counts.set(fact.relationNorm, (counts.get(fact.relationNorm) ?? 0) + 1);
    }
    for (const [relationNorm, count] of counts) {
      expect(packet.relationNormCounts[relationNorm]).toBe(count);
    }

    const factKeys = packet.facts.map((fact) => fact.factKey);
    expect(new Set(factKeys).size).toBe(factKeys.length);

    for (const fact of packet.facts) {
      expect(packet.unitIds).toContain(fact.unitId);
      expect(fact.spanStart).toBeGreaterThanOrEqual(0);
      expect(fact.spanEnd).toBeGreaterThan(fact.spanStart);
      expect(fact.spanEnd).toBeLessThanOrEqual(
        packet.unitCodepointLengths[fact.unitId] ?? Number.MAX_SAFE_INTEGER
      );
    }
  });

  it("reads the frozen original unit text at the manifest's own codepoint length, so spans cannot silently re-map", () => {
    for (const unit of packet.units) {
      const codepoints = packet.unitTextCodepoints[unit.unit_id] ?? [];
      expect(
        codepoints.length,
        `unit ${unit.unit_id} reads ${codepoints.length} codepoints from ${unit.file}, but units/manifest.json declares codepoint_length ${unit.codepoint_length}. ${UNIT_TEXT_LENGTH_SCOPE}`
      ).toBe(unit.codepoint_length);
    }
  });

  it("finds each approved fact's own head and tail canonical name inside its span of the frozen original unit text", () => {
    for (const fact of packet.facts) {
      const codepoints = packet.unitTextCodepoints[fact.unitId] ?? [];
      const slice = codepoints.slice(fact.spanStart, fact.spanEnd).join("");
      expect(
        slice.includes(fact.headName) && slice.includes(fact.tailName),
        `fact ${fact.factKey} claims head ${fact.headName} and tail ${fact.tailName}, but the text of its own span [${fact.spanStart}, ${fact.spanEnd}) in unit ${fact.unitId} (${packet.units.find((unit) => unit.unit_id === fact.unitId)?.file ?? "unknown file"}) contains head: ${slice.includes(fact.headName)}, tail: ${slice.includes(fact.tailName)}. A span that does not name its own subject and object means either the fact is mislabeled or the unit text is shifted; the unit length assertion above separates those. ${SPAN_SUBJECT_OBJECT_SCOPE}`
      ).toBe(true);
    }
  });

  it("persists one approved source version, its locator bindings and every expected support with its extraction link", async () => {
    const scopeBinding = unique("ingest-scope");
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const occurrences: StructuredIngestOccurrence[] = [];
    for (const fact of packet.facts) {
      const resultId = await registerFactIdentities(fact);
      occurrences.push({
        subject: "assertion",
        resultId,
        location: {
          document_id: fact.unitId,
          version: packet.sourceVersion,
          unit: fact.unitNumber,
        },
        span: { start: fact.spanStart, end: fact.spanEnd },
        extractionRef: fact.extractionRef,
        extractedAt: EXTRACTED_AT,
      });
    }

    const request: StructuredIngestRequest = { ...baseRequest(), occurrences };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [packet.sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const outcome = await ingestStructuredSource(authority, scope, request);

    expect(outcome.sourceVersion.source_ref).toBe(packet.sourceRef);
    expect(outcome.sourceVersion.source_version).toBe(packet.sourceVersion);
    expect(outcome.sourceVersion.content_digest).toBe(packet.contentDigest);
    expect(outcome.sourceVersion.origin_object_ref).toBe(
      packet.originObjectRef
    );
    expect(outcome.sourceVersion.parser_revision).toBe(
      packet.sourceParserRevision
    );
    expect(outcome.sourceVersion.created_at).toBe(
      new Date(CREATED_AT).toISOString()
    );

    const sourceVersionRows = await countRows(
      "SELECT count(*)::text AS count FROM source_versions WHERE source_ref = $1 AND source_version = $2",
      [packet.sourceRef, packet.sourceVersion]
    );
    expect(sourceVersionRows).toBe(1);

    const locatorRows = await pool.query<{
      document_id: string;
      unit_version: string;
      unit: number;
    }>(
      `SELECT l.document_id, l.unit_version, l.unit
         FROM source_version_locators l
         JOIN source_versions v ON v.source_version_id = l.source_version_id
        WHERE v.source_ref = $1 AND v.source_version = $2
        ORDER BY l.unit`,
      [packet.sourceRef, packet.sourceVersion]
    );
    expect(locatorRows.rows, UNIT_ORDINAL_DECISION).toEqual(
      packet.unitIds.map((unitId, index) => ({
        document_id: unitId,
        unit_version: packet.sourceVersion,
        unit: index + 1,
      }))
    );

    const manifestRow = await pool.query<{ unit_manifest: unknown }>(
      `SELECT unit_manifest
         FROM source_versions
        WHERE source_ref = $1 AND source_version = $2`,
      [packet.sourceRef, packet.sourceVersion]
    );
    const persistedManifest = manifestRow.rows[0]?.unit_manifest as
      { readonly units?: readonly Record<string, unknown>[] } | undefined;
    const persistedUnits = persistedManifest?.units ?? [];
    expect(
      persistedUnits
        .map((entry) => entry.unit_id)
        .slice()
        .sort(),
      UNIT_MANIFEST_READBACK_SCOPE
    ).toEqual(packet.unitIds.slice().sort());
    for (const unit of packet.units) {
      const persisted = persistedUnits.find(
        (entry) => entry.unit_id === unit.unit_id
      );
      expect(
        persisted,
        `source_versions.unit_manifest holds no entry for unit ${unit.unit_id}. ${UNIT_MANIFEST_READBACK_SCOPE}`
      ).toBeDefined();
      expect(
        persisted,
        `source_versions.unit_manifest for unit ${unit.unit_id} must carry every field units/manifest.json declares for it. ${UNIT_MANIFEST_READBACK_SCOPE}`
      ).toEqual({
        unit_id: unit.unit_id,
        file: unit.file,
        parser_revision: unit.parser_revision,
        locator: unit.locator,
        codepoint_length: unit.codepoint_length,
        unit_sha256: unit.unit_sha256,
      });
    }
    expect(outcome.locators).toHaveLength(packet.unitIds.length);

    expect(outcome.supports).toHaveLength(packet.facts.length);
    expect(outcome.supports.every((entry) => entry.created)).toBe(true);

    const rows = await readResolvedSupports(
      packet.sourceRef,
      packet.sourceVersion
    );
    expect(rows).toHaveLength(packet.facts.length);
    expect(
      rows.map(rowSupportKey).sort(),
      "each support must resolve through structured_relation_assertion_identities to the exact oracle fact, unit and span"
    ).toEqual(packet.facts.map(expectedSupportKey).sort());
    expect(
      new Set(rows.map((row) => row.result_id)).size,
      `each oracle fact must resolve to its own registered relation-assertion identity; exact backend-assigned identifiers are frozen by ${BACKEND_IDENTIFIER_FREEZE_OWNER}, not asserted here`
    ).toBe(packet.facts.length);
    for (const row of rows) {
      expect(row.result_id).toMatch(UUID_SHAPE);
    }

    const factByKey = new Map<string, ApprovedFact>(
      packet.facts.map((fact) => [expectedSupportKey(fact), fact])
    );
    for (const row of rows) {
      const fact = factByKey.get(rowSupportKey(row));
      if (fact === undefined) {
        throw new Error(
          `no oracle fact matches the resolved support ${rowSupportKey(row)}`
        );
      }
      const links = await pool.query<{ extraction_ref: string }>(
        `SELECT e.extraction_ref
           FROM support_extractions e
          WHERE e.support_id = (
                  SELECT s.support_id
                    FROM assertion_supports s
                   WHERE s.result_id = $1
                     AND s.source_ref = $2
                     AND s.source_version = $3
                     AND s.document_id = $4
                     AND s.unit = $5)
          ORDER BY e.extraction_ref`,
        [
          row.result_id,
          packet.sourceRef,
          packet.sourceVersion,
          row.document_id,
          row.unit,
        ]
      );
      expect(links.rows.map((entry) => entry.extraction_ref)).toEqual([
        fact.extractionRef,
      ]);
    }
  });

  it("mints no evidence grant row while ingesting a source version", async () => {
    const scopeBinding = unique("grant-scope");
    const sourceRef = unique("grant-source");
    const unitId = `${sourceRef}-unit`;
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const fact = syntheticFact("GRANT", unitId, 10, 20);
    const resultId = await registerFactIdentities(fact);
    const location = { document_id: unitId, version: "frozen-v1", unit: 1 };
    const request: StructuredIngestRequest = {
      sourceVersion: {
        source_ref: sourceRef,
        source_version: "v1",
        content_digest: packet.contentDigest,
        origin_object_ref: `objects/${sourceRef}/v1.html`,
        parser_revision: packet.sourceParserRevision,
        unit_manifest: { units: [unitId] },
        created_at: CREATED_AT,
        retired_at: null,
        payload_collected_at: null,
        obligations_stopped_at: null,
      },
      locators: [location],
      occurrences: [
        {
          subject: "assertion",
          resultId,
          location,
          span: { start: fact.spanStart, end: fact.spanEnd },
          extractionRef: fact.extractionRef,
          extractedAt: EXTRACTED_AT,
        },
      ],
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const grantsBefore = await readGrantCount();
    const sourceVersionsBefore = await countRows(
      "SELECT count(*)::text AS count FROM source_versions"
    );

    const outcome = await ingestStructuredSource(authority, scope, request);

    expect(
      outcome.supports.map((entry) => entry.created),
      "this case must perform its own ingest, so a green result cannot mean nothing ran"
    ).toEqual([true]);
    expect(outcome.sourceVersionCreated).toBe(true);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM assertion_supports WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(1);
    expect(
      await countRows("SELECT count(*)::text AS count FROM source_versions")
    ).toBe(sourceVersionsBefore + 1);
    expect(await readGrantCount()).toBe(grantsBefore);
  });

  it("accepts an owner-validated supplied snapshot and pins every dependency", async () => {
    const scopeBinding = unique("snapshot-scope");
    const sourceRef = unique("snapshot-source");
    const unitId = `${sourceRef}-unit`;
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const fact = syntheticFact("SNAPSHOT", unitId, 30, 60);
    const resultId = await registerFactIdentities(fact);
    const location = { document_id: unitId, version: "frozen-v1", unit: 1 };
    const request: StructuredIngestRequest = {
      sourceVersion: {
        source_ref: sourceRef,
        source_version: "v1",
        content_digest: packet.contentDigest,
        origin_object_ref: `objects/${sourceRef}/v1.html`,
        parser_revision: packet.sourceParserRevision,
        unit_manifest: { units: [unitId] },
        created_at: CREATED_AT,
        retired_at: null,
        payload_collected_at: null,
        obligations_stopped_at: null,
      },
      locators: [location],
      occurrences: [
        {
          subject: "assertion",
          resultId,
          location,
          span: { start: fact.spanStart, end: fact.spanEnd },
          extractionRef: fact.extractionRef,
          extractedAt: EXTRACTED_AT,
        },
      ],
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const outcome = await ingestStructuredSource(authority, scope, request);
    const supportId = outcome.supports[0]!.support.support_id;
    const plan = rowGrantPlan({
      scopeBinding,
      readRevision: AUTHORIZATION_REVISION,
      queriedAt: EXTRACTED_AT,
      sourceRef,
      supports: [
        { support_id: supportId, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
      ],
    });

    const grant = await inEvidenceTransaction(
      () => pool.connect(),
      (client) => issueGrantRows(client, plan)
    );

    expect(grant.evidence_ref).toBe(plan.evidenceRef);
    expect(grant.kind).toBe(EVIDENCE_GRANT_KIND.ROW);
    expect(grant.scope_binding).toBe(scopeBinding);
    expect(grant.read_revision).toBe(AUTHORIZATION_REVISION);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM evidence_grants WHERE evidence_ref = $1",
        [plan.evidenceRef]
      )
    ).toBe(1);
    const pinnedSupports = await pool.query<{
      support_id: string;
      role: string;
    }>(
      "SELECT support_id, role FROM evidence_grant_supports WHERE evidence_ref = $1",
      [plan.evidenceRef]
    );
    expect(pinnedSupports.rows).toEqual([
      { support_id: supportId, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
    ]);
    const pinnedLinks = await pool.query<{ extraction_ref: string }>(
      "SELECT extraction_ref FROM evidence_grant_extractions WHERE evidence_ref = $1 ORDER BY extraction_ref",
      [plan.evidenceRef]
    );
    expect(pinnedLinks.rows.map((row) => row.extraction_ref)).toEqual([
      fact.extractionRef,
    ]);
  });

  it("refuses an unvalidated supplied snapshot whose support does not resolve", async () => {
    const scopeBinding = unique("snapshot-refusal-scope");
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);
    const grantsBefore = await readGrantCount();
    const plan = rowGrantPlan({
      scopeBinding,
      readRevision: AUTHORIZATION_REVISION,
      queriedAt: EXTRACTED_AT,
      sourceRef: unique("snapshot-refusal-source"),
      supports: [
        { support_id: randomUUID(), role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
      ],
    });

    const code = await codeOf(
      inEvidenceTransaction(
        () => pool.connect(),
        (client) => issueGrantRows(client, plan)
      )
    );

    expect(code).toBe("unsupported_source_binding");
    expect(await readGrantCount()).toBe(grantsBefore);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM evidence_grant_supports WHERE evidence_ref = $1",
        [plan.evidenceRef]
      )
    ).toBe(0);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM evidence_grant_extractions WHERE evidence_ref = $1",
        [plan.evidenceRef]
      )
    ).toBe(0);
  });

  it("refuses an occurrence whose resultId names no registered identity, and writes no support", async () => {
    const scopeBinding = unique("dangling-identity-scope");
    const sourceRef = unique("dangling-identity-source");
    const unitId = `${sourceRef}-unit`;
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const fact = syntheticFact("DANGLING", unitId, 40, 80);
    const location = { document_id: unitId, version: "frozen-v1", unit: 1 };
    const request: StructuredIngestRequest = {
      sourceVersion: {
        source_ref: sourceRef,
        source_version: "v1",
        content_digest: packet.contentDigest,
        origin_object_ref: `objects/${sourceRef}/v1.html`,
        parser_revision: packet.sourceParserRevision,
        unit_manifest: { units: [unitId] },
        created_at: CREATED_AT,
        retired_at: null,
        payload_collected_at: null,
        obligations_stopped_at: null,
      },
      locators: [location],
      occurrences: [
        {
          subject: "assertion",
          resultId: randomUUID(),
          location,
          span: { start: fact.spanStart, end: fact.spanEnd },
          extractionRef: fact.extractionRef,
          extractedAt: EXTRACTED_AT,
        },
      ],
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const code = await codeOf(
      ingestStructuredSource(authority, scope, request)
    );

    expect(code).toBe("unsupported_source_binding");
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM assertion_supports WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(0);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM support_extractions WHERE support_id NOT IN (SELECT support_id FROM assertion_supports)",
        []
      )
    ).toBe(0);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM source_versions WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(0);
  });

  it("refuses a source_ref the run's authorized set does not name, before any statement runs", async () => {
    const scopeBinding = unique("unauthorized-scope");
    const authorizedRef = unique("authorized-only-source");
    const refusedRef = unique("unauthorized-source");
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const request: StructuredIngestRequest = {
      ...baseRequest(),
      sourceVersion: {
        ...baseRequest().sourceVersion,
        source_ref: refusedRef,
        source_version: "v1",
        origin_object_ref: `objects/${refusedRef}/v1.html`,
      },
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [authorizedRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const code = await codeOf(
      ingestStructuredSource(authority, scope, request)
    );

    expect(code).toBe("access_denied");
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM source_versions WHERE source_ref = $1",
        [refusedRef]
      )
    ).toBe(0);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM assertion_supports WHERE source_ref = $1",
        [refusedRef]
      )
    ).toBe(0);
    expect(
      await countRows(
        `SELECT count(*)::text AS count
           FROM source_version_locators l
           JOIN source_versions v ON v.source_version_id = l.source_version_id
          WHERE v.source_ref = $1`,
        [refusedRef]
      )
    ).toBe(0);
  });

  it("refuses a caller whose trusted scope no longer carries its authorization revision", async () => {
    const scopeBinding = unique("stale-auth-scope");
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);
    const stale = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [packet.sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });
    await admitScope(scopeBinding, "ingest-auth-2");
    const sourceVersionsBefore = await countRows(
      "SELECT count(*)::text AS count FROM source_versions"
    );
    const supportsBefore = await countRows(
      "SELECT count(*)::text AS count FROM assertion_supports"
    );

    const code = await codeOf(
      ingestStructuredSource(authority, stale, baseRequest())
    );

    expect(code).toBe("access_denied");
    expect(
      await countRows("SELECT count(*)::text AS count FROM source_versions")
    ).toBe(sourceVersionsBefore);
    expect(
      await countRows("SELECT count(*)::text AS count FROM assertion_supports")
    ).toBe(supportsBefore);
  });

  it("refuses a scope that does not own an existing source, and leaves no source version behind", async () => {
    const ownerScope = unique("foreign-owner-scope");
    const callerScope = unique("foreign-caller-scope");
    const foreignSource = unique("foreign-owned-source");
    await admitScope(ownerScope, AUTHORIZATION_REVISION);
    await admitScope(callerScope, AUTHORIZATION_REVISION);

    const ownerSeed = {
      ...baseRequest(),
      sourceVersion: {
        ...baseRequest().sourceVersion,
        source_ref: foreignSource,
        source_version: "foreign-v1",
        origin_object_ref: "objects/foreign/v1.html",
      },
      locators: [
        { document_id: `${foreignSource}-doc`, version: "frozen-v1", unit: 1 },
      ],
    };
    const ownerOutcome = await ingestStructuredSource(
      authority,
      context({
        actorId: ACTOR,
        ownerScopeBinding: ownerScope,
        readerBinding: READER,
        authorizedSourceRefs: [foreignSource],
        authorizationRevision: AUTHORIZATION_REVISION,
        deadlineAt: farDeadline(),
      }),
      ownerSeed
    );
    await publication.declareDesired({
      scopeBinding: ownerScope,
      authorizedSourceRefs: [foreignSource],
      sourceRef: foreignSource,
      sourceVersion: ownerSeed.sourceVersion,
      locatorBindings: ownerOutcome.locators,
      desiredExtractionRevision: 1,
      configRevision: "extractor-v1",
    });

    const callerAttempt = {
      ...baseRequest(),
      sourceVersion: {
        ...baseRequest().sourceVersion,
        source_ref: foreignSource,
        source_version: "foreign-v2",
        origin_object_ref: "objects/foreign/v2.html",
      },
    };
    const callerContext = context({
      actorId: ACTOR,
      ownerScopeBinding: callerScope,
      readerBinding: READER,
      authorizedSourceRefs: [foreignSource],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const code = await codeOf(
      ingestStructuredSource(authority, callerContext, callerAttempt)
    );

    expect(code).toBe("unsupported_source_binding");
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM source_versions WHERE source_ref = $1 AND source_version = $2",
        [foreignSource, "foreign-v2"]
      )
    ).toBe(0);
  });

  it("keeps one support with multiple extraction links when the same span is extracted twice", async () => {
    const scopeBinding = unique("duplicate-span-scope");
    const sourceRef = unique("duplicate-span-source");
    const unitId = `${sourceRef}-unit`;
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const fact = syntheticFact("DUP", unitId, 123, 376);
    const resultId = await registerFactIdentities(fact);
    const location = { document_id: unitId, version: "frozen-v1", unit: 1 };
    const request: StructuredIngestRequest = {
      sourceVersion: {
        source_ref: sourceRef,
        source_version: "v1",
        content_digest: packet.contentDigest,
        origin_object_ref: `objects/${sourceRef}/v1.html`,
        parser_revision: packet.sourceParserRevision,
        unit_manifest: { units: [unitId] },
        created_at: CREATED_AT,
        retired_at: null,
        payload_collected_at: null,
        obligations_stopped_at: null,
      },
      locators: [location],
      occurrences: [
        {
          subject: "assertion",
          resultId,
          location,
          span: { start: fact.spanStart, end: fact.spanEnd },
          extractionRef: "extraction-alpha",
          extractedAt: EXTRACTED_AT,
        },
        {
          subject: "assertion",
          resultId,
          location,
          span: { start: fact.spanStart, end: fact.spanEnd },
          extractionRef: "extraction-beta",
          extractedAt: EXTRACTED_AT,
        },
      ],
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const outcome = await ingestStructuredSource(authority, scope, request);

    expect(outcome.supports).toHaveLength(2);
    expect(outcome.supports.map((entry) => entry.created)).toEqual([
      true,
      false,
    ]);
    expect(outcome.supports[0]!.support.support_id).toBe(
      outcome.supports[1]!.support.support_id
    );
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM assertion_supports WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(1);
    const links = await pool.query<{ extraction_ref: string }>(
      `SELECT e.extraction_ref
         FROM support_extractions e
         JOIN assertion_supports s ON s.support_id = e.support_id
        WHERE s.source_ref = $1
        ORDER BY e.extraction_ref`,
      [sourceRef]
    );
    expect(links.rows.map((row) => row.extraction_ref)).toEqual([
      "extraction-alpha",
      "extraction-beta",
    ]);
  });

  it("refuses a locator that names a source version which is not the one being registered", async () => {
    const scopeBinding = unique("foreign-locator-scope");
    const sourceRef = unique("foreign-locator-source");
    const otherSourceRef = unique("other-version-source");
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const otherRequest: StructuredIngestRequest = {
      ...baseRequest(),
      sourceVersion: {
        ...baseRequest().sourceVersion,
        source_ref: otherSourceRef,
        source_version: "other-v1",
        origin_object_ref: `objects/${otherSourceRef}/v1.html`,
      },
      locators: [
        { document_id: `${otherSourceRef}-doc`, version: "frozen-v1", unit: 1 },
      ],
    };
    await ingestStructuredSource(
      authority,
      context({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding: READER,
        authorizedSourceRefs: [otherSourceRef],
        authorizationRevision: AUTHORIZATION_REVISION,
        deadlineAt: farDeadline(),
      }),
      otherRequest
    );
    const otherVersionId = (
      await pool.query<{ source_version_id: string }>(
        "SELECT source_version_id FROM source_versions WHERE source_ref = $1 AND source_version = $2",
        [otherSourceRef, "other-v1"]
      )
    ).rows[0]!.source_version_id;

    const request: StructuredIngestRequest = {
      ...baseRequest(),
      sourceVersion: {
        ...baseRequest().sourceVersion,
        source_ref: sourceRef,
        source_version: "v1",
        origin_object_ref: `objects/${sourceRef}/v1.html`,
      },
      locators: [
        {
          document_id: `${sourceRef}-doc`,
          version: "frozen-v1",
          unit: 1,
          sourceVersionId: otherVersionId,
        },
      ],
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const code = await codeOf(
      ingestStructuredSource(authority, scope, request)
    );

    expect(code).toBe("unsupported_source_binding");
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM source_versions WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(0);
  });

  it("is idempotent for a repeated ingest of the same approved source version", async () => {
    const scopeBinding = unique("replay-scope");
    const sourceRef = unique("replay-source");
    const unitId = `${sourceRef}-unit`;
    await admitScope(scopeBinding, AUTHORIZATION_REVISION);

    const fact = syntheticFact("REPLAY", unitId, 10, 20);
    const resultId = await registerFactIdentities(fact);
    const location = { document_id: unitId, version: "frozen-v1", unit: 1 };
    const request: StructuredIngestRequest = {
      sourceVersion: {
        source_ref: sourceRef,
        source_version: "v1",
        content_digest: packet.contentDigest,
        origin_object_ref: `objects/${sourceRef}/v1.html`,
        parser_revision: packet.sourceParserRevision,
        unit_manifest: { units: [unitId] },
        created_at: CREATED_AT,
        retired_at: null,
        payload_collected_at: null,
        obligations_stopped_at: null,
      },
      locators: [location],
      occurrences: [
        {
          subject: "assertion",
          resultId,
          location,
          span: { start: fact.spanStart, end: fact.spanEnd },
          extractionRef: fact.extractionRef,
          extractedAt: EXTRACTED_AT,
        },
      ],
    };
    const scope = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: READER,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: farDeadline(),
    });

    const grantsBefore = await readGrantCount();
    const first = await ingestStructuredSource(authority, scope, request);
    const second = await ingestStructuredSource(authority, scope, request);

    expect(first.supports.map((entry) => entry.created)).toEqual([true]);
    expect(second.supports.map((entry) => entry.created)).toEqual([false]);
    expect(second.supports[0]!.support.support_id).toBe(
      first.supports[0]!.support.support_id
    );
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM source_versions WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(1);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM assertion_supports WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(1);
    expect(
      await readGrantCount(),
      "a replayed ingest must mint no production grant"
    ).toBe(grantsBefore);
  });
});
