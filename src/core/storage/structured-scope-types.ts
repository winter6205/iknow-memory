/**
 * The shared structured-corpus write-authority seam: contract, authorized
 * context, scoped input views, and typed refusals.
 *
 * Why this is its own module rather than more surface on the publication
 * adapter: publication, work settlement and status all have to take the same
 * locks in the same order or their transactions deadlock, so the contract they
 * share is declared once here and stays free of any PostgreSQL client or
 * in-memory map type. A maintenance or screening service can import these
 * shapes without acquiring a storage dependency.
 *
 * `StructuredScopeError` is runtime code rather than a pure type because a
 * refusal has to be throwable and classifiable by name; it still depends on
 * nothing outside the maintenance vocabulary.
 */
import type {
  MaintenanceDependency,
  MaintenanceWorkFailureCode,
  MaintenanceWorkKind,
  MaintenanceWorkStatus,
} from "../maintenance/types.js";
import { failureTokenOf } from "../errors.js";

/**
 * The closed set of codes this seam refuses with. `input_stale` and
 * `execution_timeout` are the two routing exits, and
 * `maintenance_status_unavailable` is the missing-required-record refusal; the
 * rest are the existing maintenance and publication codes the same transaction
 * can surface unchanged.
 */
export const STRUCTURED_SCOPE_FAILURE_CODES = [
  "invalid_input",
  "access_denied",
  "input_stale",
  "lease_lost",
  "execution_timeout",
  "maintenance_status_unavailable",
  "unsupported_source_binding",
  "resource_exhausted",
  "backend_unavailable",
] as const;

export type StructuredScopeFailureCode =
  (typeof STRUCTURED_SCOPE_FAILURE_CODES)[number];

const SCOPE_CODES = new Set<string>(STRUCTURED_SCOPE_FAILURE_CODES);

/** A refusal that names its class; never a bare Error and never prose. */
export class StructuredScopeError extends Error {
  constructor(
    readonly code: StructuredScopeFailureCode,
    message: string,
    options?: { readonly cause?: unknown }
  ) {
    super(message, { cause: options?.cause });
    this.name = "StructuredScopeError";
  }
}

/** Narrow a failure to the codes this seam is allowed to publish. */
export function structuredScopeCodeOf(code: unknown): StructuredScopeFailureCode | undefined {
  return typeof code === "string" && SCOPE_CODES.has(code)
    ? (code as StructuredScopeFailureCode)
    : undefined;
}

/**
 * Re-raise anything that reaches the seam boundary as a typed failure.
 *
 * A code that already belongs to the vocabulary survives — masking a
 * `lease_lost` as `backend_unavailable` would lose the fence verdict the caller
 * branches on. An unmappable value becomes `backend_unavailable`, which is the
 * only honest reading of a storage fault with no name.
 */
export function structuredScopeError(error: unknown): StructuredScopeError {
  if (error instanceof StructuredScopeError) return error;
  const coded = error as { readonly code?: unknown };
  const direct =
    structuredScopeCodeOf(coded?.code) ?? structuredScopeCodeOf(failureTokenOf(error));
  const message = error instanceof Error ? error.message : String(error);
  return new StructuredScopeError(
    direct ?? "backend_unavailable",
    message,
    { cause: error }
  );
}

/**
 * Routing is bounded so a contended ownership set cannot spin forever. Three
 * attempts mirrors the durable-work retry budget's shape: exhaustion is a
 * visible typed refusal, never a silent empty success.
 */
export const STRUCTURED_SCOPE_MAX_ROUTING_ATTEMPTS = 3;

/** One source's owner as resolved without any write lock. */
export interface SourceOwnership {
  readonly sourceRef: string;
  readonly ownerScopeBinding: string | null;
}

/**
 * The trusted authority a unit of work runs under. Minted only by server
 * composition through `AuthorizedScopeUnitOfWork.createAuthorizedContext`;
 * nothing here is parsed from model or query input, and a model cannot select
 * another actor's owner, reader, authorization set, or deadline.
 */
export interface AuthorizedScopeContext {
  /** The authenticated server principal that minted this context. */
  readonly actorId: string;
  /** The single owner scope whose sources this write may mutate. */
  readonly ownerScopeBinding: string;
  /**
   * The reader whose authorized subset the views expose. A reader selects a
   * view, never another owner's lifecycle, so the owner stays the writer.
   */
  readonly readerBinding: string;
  /** The complete source set the owner scope is authorized over. */
  readonly authorizedSourceRefs: readonly string[];
  /** The authorization snapshot this run is bound to. */
  readonly authorizationRevision: string;
  /** Wall-clock bound past which the run refuses instead of writing. */
  readonly deadlineAt: string;
}

/** What trusted composition supplies when it mints a context. */
export interface AuthorizedScopeContextInput {
  readonly actorId: string;
  readonly ownerScopeBinding: string;
  readonly readerBinding: string;
  readonly authorizedSourceRefs: readonly string[];
  readonly authorizationRevision: string;
  readonly deadlineAt: string;
}

/** Per-run bounds a caller may add without widening its authority. */
export interface AuthorizedScopeRunOptions {
  /** Declaration-style writes may introduce sources no scope owns yet. */
  readonly authorizeNewSources?: boolean;
  /**
   * Extra sources in this same owner scope whose rows the run must lock before
   * writing — a work attempt's dependency vector. A subset of the trusted
   * context is the only legal value: a caller cannot widen its own authority.
   */
  readonly additionalSourceRefs?: readonly string[];
}

/**
 * Contexts are remembered by identity together with the authority that minted
 * them, so a value assembled structurally (for example from model output) is
 * refused before it can reach a lock, and a caller never has to name which
 * backend its own context belongs to.
 */
const MINTED_CONTEXTS = new WeakMap<object, AuthorizedScopeUnitOfWork>();

function requireScopeString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StructuredScopeError(
      "invalid_input",
      `${field} must be a non-empty string`
    );
  }
  return value.trim();
}

function requireScopeRefs(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string")) {
    throw new StructuredScopeError(
      "invalid_input",
      `${field} must be an array of source references`
    );
  }
  const refs = value as string[];
  if (refs.some((ref) => ref.trim() === "")) {
    throw new StructuredScopeError(
      "invalid_input",
      `${field} must not contain a blank source reference`
    );
  }
  return [...new Set(refs)].sort((left, right) => left.localeCompare(right));
}

/**
 * Validate and mint the trusted context.
 *
 * Canonicalizing the source set (dedup, sort) is what makes the stable lock
 * order a property of the context rather than of whatever order a caller
 * happened to build it with. An empty set is deliberately NOT refused here: a
 * run with nothing to lock is a refusal the caller has to observe as a typed
 * outcome of the unit of work, not as an exception from an argument builder.
 */
export function mintAuthorizedScopeContext(
  input: AuthorizedScopeContextInput,
  authority: AuthorizedScopeUnitOfWork
): AuthorizedScopeContext {
  const context: AuthorizedScopeContext = Object.freeze({
    actorId: requireScopeString(input?.actorId, "actorId"),
    ownerScopeBinding: requireScopeString(
      input?.ownerScopeBinding,
      "ownerScopeBinding"
    ),
    readerBinding: requireScopeString(input?.readerBinding, "readerBinding"),
    authorizedSourceRefs: Object.freeze(
      requireScopeRefs(input?.authorizedSourceRefs, "authorizedSourceRefs")
    ),
    authorizationRevision: requireScopeString(
      input?.authorizationRevision,
      "authorizationRevision"
    ),
    deadlineAt: requireScopeInstant(input?.deadlineAt),
  });
  MINTED_CONTEXTS.set(context, authority);
  return context;
}

function requireScopeInstant(value: unknown): string {
  const text = requireScopeString(value, "deadlineAt");
  if (!Number.isFinite(Date.parse(text))) {
    throw new StructuredScopeError(
      "invalid_input",
      "deadlineAt must be an ISO instant"
    );
  }
  return text;
}

/** The authority that minted this context, or a refusal for anything else. */
export function scopeAuthorityOf(
  context: AuthorizedScopeContext
): AuthorizedScopeUnitOfWork {
  const authority = MINTED_CONTEXTS.get(context);
  if (authority === undefined) {
    throw new StructuredScopeError(
      "access_denied",
      "the authorized scope context was not minted by trusted composition"
    );
  }
  return authority;
}

/** Whether a source row belongs to a reader's authorized active set. */
export function isScopedSourceActive(
  source: ScopedSourceInput | ScopedMaintenanceSourceInput
): boolean {
  return source.active === true;
}

/** One attributed display value bound to a support and extraction revision. */
export interface ScopedAttributedValue {
  readonly supportId: string;
  readonly extractionRevision: number;
  readonly canonicalName: string;
  readonly entityType: string;
}

/**
 * One current accepted membership row: what this source actually serves.
 * Supports are grouped per result so a reader sees one row per result it can
 * act on rather than a fan-out it would have to re-join.
 */
export interface ScopedMembershipInput {
  readonly sourceRef: string;
  readonly subject: "entity" | "assertion";
  readonly resultId: string;
  readonly supportIds: readonly string[];
  readonly extractionRefs: readonly string[];
}

/** One extraction revision's refs and the values attributed to them. */
export interface ScopedExtractionInput {
  readonly sourceRef: string;
  readonly extractionRef: string;
  readonly attributedValues: readonly ScopedAttributedValue[];
}

/** The desired and published pair a source is currently bound to. */
export interface ScopedSourcePair {
  readonly sourceVersion: string;
  readonly extractionRevision: number;
  readonly configRevision?: string;
}

/** One source inside the authorized set. */
export interface ScopedSourceInput {
  readonly sourceRef: string;
  readonly sourceVersion: string | null;
  readonly active: boolean;
  readonly generation: number;
  readonly desired: ScopedSourcePair | null;
  readonly published: ScopedSourcePair | null;
}

/** The accepted-corpus view: current serving state, no hidden sources. */
export interface AcceptedInputSnapshot {
  readonly ownerScopeBinding: string;
  readonly readerBinding: string;
  readonly authorizationRevision: string;
  readonly readRevision: number;
  readonly sources: readonly ScopedSourceInput[];
  readonly memberships: readonly ScopedMembershipInput[];
  readonly extractions: readonly ScopedExtractionInput[];
}

/** The actual work ledger rows bound to one authorized source. */
export interface ScopedWorkInput {
  readonly jobKey: string;
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly sourceGeneration: number;
  readonly inputRevision: string;
  readonly configRevision: string;
  readonly status: MaintenanceWorkStatus;
  readonly attemptCount: number;
  readonly autoAttemptCount: number;
  readonly lastFailureCode: MaintenanceWorkFailureCode | null;
  readonly nextAttemptAt: string | null;
  readonly updatedAt: string;
  readonly dependencies: readonly MaintenanceDependency[];
}

/** One source plus the desired and check records it actually has. */
export interface ScopedMaintenanceSourceInput {
  readonly sourceRef: string;
  readonly sourceVersion: string | null;
  readonly active: boolean;
  readonly generation: number;
  readonly desired: ScopedSourcePair | null;
  readonly published: ScopedSourcePair | null;
}

/** The maintenance view: buckets come from these rows, never from a summary. */
export interface MaintenanceInputSnapshot {
  readonly ownerScopeBinding: string;
  readonly readerBinding: string;
  readonly authorizationRevision: string;
  readonly maintenanceRevision: number;
  readonly sources: readonly ScopedMaintenanceSourceInput[];
  readonly work: readonly ScopedWorkInput[];
}

/**
 * Read-only view of the exact authoritative state inside one unit of work.
 * A requested subset wider than the trusted context refuses before any write.
 */
export interface ScopedInputView {
  readonly context: AuthorizedScopeContext;
  readAcceptedInputs(
    authorizedSourceRefs: readonly string[]
  ): Promise<AcceptedInputSnapshot>;
  readMaintenanceInputs(
    authorizedSourceRefs: readonly string[]
  ): Promise<MaintenanceInputSnapshot>;
}

/** The one transaction client a seam run owns. `pg.PoolClient` satisfies it. */
export interface ScopeTransactionClient {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: any[] }>;
  release(): void;
}

/** Lease anything that can hand out such a client: a `pg.Pool` satisfies it. */
export interface ScopeClientLease {
  (): Promise<ScopeTransactionClient>;
}

/**
 * What a callback receives. The handle *is* the scoped input view plus the
 * commit capabilities of one backend, so a reader-only caller can type the
 * parameter as the view alone and still be handed a live handle.
 */
export interface ScopeWorkHandle extends ScopedInputView {
  /**
   * Register a revision advance for the commit step. Advances are deferred so
   * the visible counters move exactly once, after every fallible step.
   */
  bumpRevisions(change: ScopeRevisionChange): void;
}

/** What a PostgreSQL callback receives: the same client plus its scoped view. */
export interface AuthorizedScopeWork extends ScopeWorkHandle {
  readonly client: ScopeTransactionClient;
}

/**
 * What a memory callback receives: the scoped view and a place to register the
 * synchronous commit closure for each prepared mutation plan. Nothing may be
 * awaited between the closures running.
 */
export interface PreparedMemoryScopeWork extends ScopeWorkHandle {
  prepare(commit: () => void): void;
}

/** The seam every authorized writer is supplied with, exactly once. */
export interface StructuredScopeUnitOfWork<TWork extends ScopeWorkHandle> {
  createAuthorizedContext(input: AuthorizedScopeContextInput): AuthorizedScopeContext;
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: TWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

/**
 * The backend-neutral surface the exported `withAuthorizedScope` needs: a
 * context carries the authority that minted it, so a caller never passes a
 * second argument that could disagree with the first.
 */
export interface AuthorizedScopeUnitOfWork {
  createAuthorizedContext(input: AuthorizedScopeContextInput): AuthorizedScopeContext;
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: ScopeWorkHandle) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

/** Revision families the same-client hook can advance. */
export interface ScopeRevisionChange {
  readonly read: boolean;
  readonly maintenance: boolean;
}

/** The live revision counters of one scope. */
export interface ScopeRevisionState {
  readonly readRevision: number;
  readonly maintenanceRevision: number;
}

/**
 * The reservation and lock helpers publication and work settlement share.
 * Centralizing them here is what keeps one lock order instead of two orders
 * that can form a cycle.
 */
export interface ScopeLockCoordinator<TClient> {
  /** Resolve ownership with no write lock of any kind. */
  resolveOwnership(
    client: TClient,
    sourceRefs: readonly string[]
  ): Promise<readonly SourceOwnership[]>;
  /** Attempt the stable-order reservations; false means someone else holds. */
  reserveSources(
    client: TClient,
    sourceRefs: readonly string[]
  ): Promise<boolean>;
  /** Take the stable-order reservations and wait for them. */
  reserveSourcesBlocking(
    client: TClient,
    sourceRefs: readonly string[]
  ): Promise<void>;
  lockOwnerScope(client: TClient, scopeBinding: string): Promise<void>;
  lockAffectedSources(
    client: TClient,
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): Promise<void>;
  /** The same-client replacement for the old scope-after-job progress trigger. */
  advanceRevision(
    client: TClient,
    scopeBinding: string,
    change: ScopeRevisionChange
  ): Promise<void>;
}
