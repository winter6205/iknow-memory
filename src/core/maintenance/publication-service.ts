import { createHash } from "node:crypto";

import { GraphragError, failureTokenOf } from "../errors.js";
import {
  deriveRelationAssertionId,
  normalizeEntityId,
  normalizeRelationAssertion,
  requireEntityType,
  StructuredIdentityError,
  type RelationAssertionInput,
} from "../structured/identity.js";
import {
  normalizeOccurrence,
  canonicalJson,
  supportOccurrenceKey,
  type NormalizedSupport,
} from "../storage/evidence-source.js";
import type { EntityType } from "../extraction/entity-type.js";
import type { MaintenanceWorkFailureCode } from "./types.js";
import type {
  DeclarePublicationDesiredInput,
  PublicationFact,
  PublishStructuredInput,
  StagePublicationAttemptInput,
  StructuredPublicationStorage,
  WithdrawStructuredSourceInput,
} from "./publication-types.js";
import type { SourceLocatorBinding } from "../types.js";

export type StructuredPublicationFailureCode =
  | MaintenanceWorkFailureCode
  | "maintenance_status_unavailable"
  | "access_denied"
  | "unsupported_source_binding";

/** Every code `publicationError` is allowed to pass through unchanged. */
const PUBLICATION_FAILURE_CODES: readonly string[] = [
  "invalid_input",
  "backend_unavailable",
  "lease_lost",
  "input_stale",
  "execution_timeout",
  "resource_exhausted",
  "maintenance_status_unavailable",
  "access_denied",
  "unsupported_source_binding",
];

export interface NormalizedPublicationFact {
  readonly fact: PublicationFact;
  readonly occurrence: NormalizedSupport;
  readonly resultId: string;
  readonly subject: "entity" | "assertion";
  readonly entityType?: EntityType;
  readonly displayName?: string;
  readonly assertionInput?: RelationAssertionInput;
}

interface PublicationFactContext {
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly extractionRef: string;
  readonly occurrenceKeys: Set<string>;
  readonly entityTypes: Map<string, EntityType>;
}

/** Typed storage boundary failure for structured publication operations. */
export class StructuredPublicationError extends Error {
  constructor(
    readonly code: StructuredPublicationFailureCode,
    message: string
  ) {
    super(message);
    this.name = "StructuredPublicationError";
  }
}

export function requirePublicationString(
  value: unknown,
  field: string
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StructuredPublicationError(
      "invalid_input",
      `${field} is required`
    );
  }
  return value.trim();
}

export function requirePublicationRevision(
  value: unknown,
  field: string
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StructuredPublicationError(
      "invalid_input",
      `${field} must be a non-negative safe integer`
    );
  }
  return value;
}

export function requirePublicationInstant(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  ) {
    throw new StructuredPublicationError(
      "invalid_input",
      `${field} must be an ISO instant`
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new StructuredPublicationError(
      "invalid_input",
      `${field} must be an ISO instant`
    );
  }
  return new Date(parsed).toISOString();
}

export function validatePublicationDeclaration(
  input: DeclarePublicationDesiredInput
): DeclarePublicationDesiredInput {
  const scopeBinding = requirePublicationString(
    input?.scopeBinding,
    "scopeBinding"
  );
  const sourceRef = requirePublicationString(input?.sourceRef, "sourceRef");
  const configRevision = requirePublicationString(
    input?.configRevision,
    "configRevision"
  );
  const desiredExtractionRevision = requirePublicationRevision(
    input?.desiredExtractionRevision,
    "desiredExtractionRevision"
  );
  const authorizedSourceRefs = validateAuthorizedSources(input, sourceRef);
  validateDeclarationSource(input, sourceRef);
  validateLocatorBindings(input.locatorBindings);
  return {
    ...input,
    scopeBinding,
    sourceRef,
    configRevision,
    desiredExtractionRevision,
    authorizedSourceRefs,
  };
}

function validateAuthorizedSources(
  input: DeclarePublicationDesiredInput,
  sourceRef: string
): string[] {
  if (
    !Array.isArray(input?.authorizedSourceRefs) ||
    input.authorizedSourceRefs.length === 0
  ) {
    throw new StructuredPublicationError(
      "invalid_input",
      "authorizedSourceRefs must be a non-empty trusted list"
    );
  }
  const refs = input.authorizedSourceRefs.map((ref) =>
    requirePublicationString(ref, "authorizedSourceRef")
  );
  if (new Set(refs).size !== refs.length || !refs.includes(sourceRef)) {
    throw new StructuredPublicationError(
      "invalid_input",
      "authorizedSourceRefs must be unique and include sourceRef"
    );
  }
  return refs;
}

function validateDeclarationSource(
  input: DeclarePublicationDesiredInput,
  sourceRef: string
): void {
  if (input.sourceVersion?.source_ref !== sourceRef) {
    throw new StructuredPublicationError(
      "invalid_input",
      "source version belongs to another source"
    );
  }
}

function validateLocatorBindings(
  bindings: readonly SourceLocatorBinding[]
): void {
  if (!Array.isArray(bindings)) {
    throw new StructuredPublicationError(
      "invalid_input",
      "locatorBindings must be an array"
    );
  }
}

/** Validate identities and immutable occurrences before either adapter stages data. */
export function normalizePublicationFacts(
  facts: readonly PublicationFact[],
  sourceRef: string,
  sourceVersion: string,
  extractionRef: string
): readonly NormalizedPublicationFact[] {
  if (!Array.isArray(facts)) {
    throw new StructuredPublicationError(
      "invalid_input",
      "accepted facts must be an array"
    );
  }
  const context: PublicationFactContext = {
    sourceRef,
    sourceVersion,
    extractionRef,
    occurrenceKeys: new Set(),
    entityTypes: new Map(),
  };
  return facts.map((fact) => normalizePublicationFact(fact, context));
}

export function publicationPayloadDigest(
  facts: readonly NormalizedPublicationFact[]
): string {
  const canonicalFacts = facts
    .map((fact) => ({
      occurrenceKey: supportOccurrenceKey(fact.occurrence),
      extractionRef: fact.occurrence.extraction_ref,
      extractedAt: fact.occurrence.extracted_at,
      subject: fact.subject,
      resultId: fact.resultId,
      entityType: fact.entityType ?? null,
      displayName: fact.displayName ?? null,
    }))
    .sort(
      (left, right) =>
        left.occurrenceKey.localeCompare(right.occurrenceKey) ||
        left.extractionRef.localeCompare(right.extractionRef)
    );
  return createHash("sha256")
    .update(canonicalJson(canonicalFacts), "utf8")
    .digest("hex");
}

function normalizePublicationFact(
  fact: PublicationFact,
  context: PublicationFactContext
): NormalizedPublicationFact {
  const occurrence = normalizeFactOccurrence(fact, context);
  if (fact.identity?.kind === "entity") {
    return normalizeEntityFact(fact, occurrence, context.entityTypes);
  }
  if (fact.identity?.kind === "relation_assertion") {
    return normalizeRelationFact(fact, occurrence);
  }
  throw new StructuredPublicationError(
    "invalid_input",
    "publication fact identity kind is invalid"
  );
}

function normalizeFactOccurrence(
  fact: PublicationFact,
  context: PublicationFactContext
): NormalizedSupport {
  if (fact === null || typeof fact !== "object") {
    throw new StructuredPublicationError(
      "invalid_input",
      "publication fact must be a record"
    );
  }
  const occurrence = normalizeOccurrence(fact.occurrence);
  if (
    occurrence.source_ref !== context.sourceRef ||
    occurrence.source_version !== context.sourceVersion ||
    occurrence.extraction_ref !== context.extractionRef
  ) {
    throw new StructuredPublicationError(
      "invalid_input",
      "publication occurrence does not match its desired source and extraction"
    );
  }
  const occurrenceKey = supportOccurrenceKey(occurrence);
  if (context.occurrenceKeys.has(occurrenceKey)) {
    throw new StructuredPublicationError(
      "invalid_input",
      "publication attempt repeats one immutable support occurrence"
    );
  }
  context.occurrenceKeys.add(occurrenceKey);
  return occurrence;
}

function normalizeEntityFact(
  fact: PublicationFact,
  occurrence: NormalizedSupport,
  entityTypes: Map<string, EntityType>
): NormalizedPublicationFact {
  if (fact.identity?.kind !== "entity") {
    throw new StructuredPublicationError(
      "invalid_input",
      "entity identity is required"
    );
  }
  const resultId = normalizeEntityId(fact.identity.input.entityId);
  const entityType = requireEntityType(fact.identity.input.type);
  if (occurrence.subject !== "entity" || occurrence.result_id !== resultId) {
    throw new StructuredPublicationError(
      "invalid_input",
      "entity occurrence must name its exact entity identity"
    );
  }
  const priorType = entityTypes.get(resultId);
  if (priorType !== undefined && priorType !== entityType) {
    throw new StructuredPublicationError(
      "invalid_input",
      "one entity identity has conflicting types in a publication"
    );
  }
  entityTypes.set(resultId, entityType);
  const displayName = requirePublicationString(
    fact.display?.canonicalName,
    "entity display canonicalName"
  );
  if (fact.display?.type !== entityType) {
    throw new StructuredPublicationError(
      "invalid_input",
      "entity display type must match its registered identity type"
    );
  }
  return {
    fact,
    occurrence,
    resultId,
    subject: "entity",
    entityType,
    displayName,
  };
}

function normalizeRelationFact(
  fact: PublicationFact,
  occurrence: NormalizedSupport
): NormalizedPublicationFact {
  if (fact.identity?.kind !== "relation_assertion") {
    throw new StructuredPublicationError(
      "invalid_input",
      "relation assertion identity is required"
    );
  }
  const tuple = normalizeRelationAssertion(fact.identity.input);
  const resultId = deriveRelationAssertionId(tuple);
  if (occurrence.subject !== "assertion" || occurrence.result_id !== resultId) {
    throw new StructuredPublicationError(
      "invalid_input",
      "assertion occurrence must name its exact relation identity"
    );
  }
  if (fact.display !== undefined) {
    throw new StructuredPublicationError(
      "invalid_input",
      "relation assertions do not accept entity display values"
    );
  }
  return {
    fact,
    occurrence,
    resultId,
    subject: "assertion",
    assertionInput: fact.identity.input,
  };
}

export function publicationError(error: unknown): StructuredPublicationError {
  if (error instanceof StructuredPublicationError) return error;
  // A refusal that already names a code in this vocabulary keeps it. The seam
  // carries its code on `.code` rather than as a GraphragError failure token,
  // so it has to be read directly. Masking any of these as
  // `backend_unavailable` would lose the verdict the caller branches on: the
  // durable-work fence's `lease_lost` would read as a backend outage, and a
  // source outside its trusted set as a transient fault.
  const direct = (error as { readonly code?: unknown }).code;
  const token =
    typeof direct === "string" &&
    (PUBLICATION_FAILURE_CODES as readonly string[]).includes(direct)
      ? (direct as StructuredPublicationFailureCode)
      : failureTokenOf(error);
  if (
    token !== undefined &&
    (PUBLICATION_FAILURE_CODES as readonly string[]).includes(token)
  ) {
    return new StructuredPublicationError(
      token as StructuredPublicationFailureCode,
      errorMessage(error)
    );
  }
  if (
    error instanceof StructuredIdentityError ||
    (error instanceof GraphragError && error.code === "INVALID_INPUT")
  ) {
    return new StructuredPublicationError("invalid_input", errorMessage(error));
  }
  return new StructuredPublicationError(
    "backend_unavailable",
    errorMessage(error)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Temporary non-serving implementation used while an adapter is unavailable. */
export class UnavailableStructuredPublication implements StructuredPublicationStorage {
  async declareDesired(
    _input: DeclarePublicationDesiredInput
  ): Promise<{ readonly generation: number }> {
    return this.unavailable();
  }

  async stageAttempt(
    _input: StagePublicationAttemptInput
  ): Promise<{ readonly staged: true }> {
    return this.unavailable();
  }

  async publish(
    _input: PublishStructuredInput
  ): Promise<{ readonly published: true }> {
    return this.unavailable();
  }

  async withdraw(
    _input: WithdrawStructuredSourceInput
  ): Promise<{ readonly generation: number }> {
    return this.unavailable();
  }

  async readSnapshot(_input: {
    readonly scopeBinding: string;
  }): Promise<never> {
    return this.unavailable();
  }

  private unavailable(): never {
    // EXIT: an adapter that cannot provide authoritative publication state must refuse every operation.
    throw new StructuredPublicationError(
      "backend_unavailable",
      "structured publication storage is unavailable"
    );
  }
}
