/**
 * The shared structured-corpus write authority: one unit of work per authorized
 * scope, supplied once by backend composition to the publication, work and
 * screening adapters.
 *
 * Why this exists at all: calling the independently transaction-owning public
 * stores in sequence cannot be atomic. Publication membership, work settlement,
 * identity, evidence, revisions and the projection outbox either all become
 * visible together or none of them do, so the ownership of the transaction and
 * of the memory serialization queue has to move out of the adapters and into
 * one seam.
 *
 * PostgreSQL runs one pool client and one transaction with the locks taken in
 * `structured-scope-locks-pg.ts`'s order. Memory runs one shared serialization
 * tail with every fallible step, including each await, before any visibility
 * change, then commits each prepared plan synchronously. Public
 * transaction-owning stores are never called from inside a callback.
 */
import {
  STRUCTURED_SCOPE_MAX_ROUTING_ATTEMPTS,
  StructuredScopeError,
  mintAuthorizedScopeContext,
  scopeAuthorityOf,
  structuredScopeError,
} from "./structured-scope-types.js";
import type {
  AcceptedInputSnapshot,
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeRunOptions,
  AuthorizedScopeUnitOfWork,
  AuthorizedScopeWork,
  MaintenanceInputSnapshot,
  PreparedMemoryScopeWork,
  ScopeRevisionChange,
  ScopeRevisionState,
  ScopeTransactionClient,
  ScopeWorkHandle,
  ScopedExtractionInput,
  ScopedInputView,
  ScopedMaintenanceSourceInput,
  ScopedMembershipInput,
  ScopedSourceInput,
  ScopedWorkInput,
  SourceOwnership,
  StructuredScopeUnitOfWork,
} from "./structured-scope-types.js";
import { recordSuppressedFailure } from "../errors.js";
import {
  advanceRevision,
  currentScopeRevisions,
  lockAffectedSources,
  lockOwnerScope,
  readScopeAuthorization,
  reserveSources,
  resolveOwnership,
  rollbackRetaining,
  stableSourceRefs,
} from "./structured-scope-locks-pg.js";
import {
  buildPgAcceptedSnapshot,
  buildPgMaintenanceSnapshot,
} from "./structured-scope-reads.js";

/** Internal signal that this attempt must be discarded before any write. */
class ScopeRoutingConflict extends Error {
  constructor(readonly reason: string) {
    super(`structured scope routing restart: ${reason}`);
    this.name = "ScopeRoutingConflict";
  }
}

type RoutedAttempt<R> =
  | { readonly kind: "committed"; readonly value: R }
  | { readonly kind: "restart" };

/**
 * Run one authorized unit of work through the authority that minted its context.
 *
 * The authority travels with the context rather than as a second argument
 * because two arguments could disagree, and a caller that paired its context
 * with another scope's authority would be selecting write authority it was
 * never granted.
 */
export async function withAuthorizedScope<R>(
  context: AuthorizedScopeContext,
  callback: (work: ScopeWorkHandle) => Promise<R>,
  options?: AuthorizedScopeRunOptions
): Promise<R> {
  const authority = scopeAuthorityOf(context);
  return authority.withAuthorizedScope(context, callback, options);
}

/** A live deadline that has arrived refuses before a lock is even requested. */
function assertLiveDeadline(deadline: number, now: Date): void {
  if (now.getTime() >= deadline) {
    throw new StructuredScopeError(
      "execution_timeout",
      "the structured scope execution deadline expired before the write was committed"
    );
  }
}

function readDeadline(instant: string, now: () => Date): number {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) {
    throw new StructuredScopeError(
      "invalid_input",
      "deadlineAt must be an ISO instant"
    );
  }
  assertLiveDeadline(parsed, now());
  return parsed;
}

/**
 * The set this run may lock: the trusted context, plus the caller's own subset
 * of extra rows inside the same scope. A wider array is a refusal rather than a
 * silent truncation, because a caller that could widen the set could write
 * outside its authority.
 */
function affectedSourceRefs(
  context: AuthorizedScopeContext,
  options?: AuthorizedScopeRunOptions
): readonly string[] {
  const extra = options?.additionalSourceRefs ?? [];
  const allowed = new Set(context.authorizedSourceRefs);
  for (const sourceRef of extra) {
    if (!allowed.has(sourceRef)) {
      throw new StructuredScopeError(
        "access_denied",
        `source ${sourceRef} is outside the trusted authorized set`
      );
    }
  }
  if (context.authorizedSourceRefs.length === 0) {
    throw new StructuredScopeError(
      "invalid_input",
      "an authorized scope context must name at least one source"
    );
  }
  return stableSourceRefs([...context.authorizedSourceRefs, ...extra]);
}

/** Narrow a requested view to the trusted subset, refusing anything wider. */
function requireAuthorizedSubset(
  context: AuthorizedScopeContext,
  requested: readonly string[]
): readonly string[] {
  if (!Array.isArray(requested)) {
    throw new StructuredScopeError(
      "invalid_input",
      "a scoped input read requires an explicit source array"
    );
  }
  const allowed = new Set(context.authorizedSourceRefs);
  const widened = requested.filter((ref) => !allowed.has(ref));
  if (widened.length > 0) {
    throw new StructuredScopeError(
      "access_denied",
      `requested sources outside the trusted context: ${widened.join(", ")}`
    );
  }
  return stableSourceRefs(requested);
}

function sameOwnership(
  left: readonly SourceOwnership[],
  right: readonly SourceOwnership[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.sourceRef === right[index]!.sourceRef &&
      entry.ownerScopeBinding === right[index]!.ownerScopeBinding
  );
}

/**
 * The state a routing attempt may not observe move: ownership plus each
 * source's generation, desired pair and activity, plus the scope counters.
 * Every accepted write changes at least one of these, so a comparison here is
 * what turns "someone else wrote while I prepared" into a restart instead of a
 * lost update.
 */
function fingerprint(
  ownership: readonly SourceOwnership[],
  rows: readonly ScopedSourceInput[],
  revisions: ScopeRevisionState | null
): string {
  const sources = rows
    .map(
      (row) =>
        `${row.sourceRef}=${row.generation}:${row.active}:${row.desired?.extractionRevision ?? "-"}:${row.desired?.sourceVersion ?? "-"}`
    )
    .join(";");
  return `${ownership.map((entry) => `${entry.sourceRef}@${entry.ownerScopeBinding ?? "none"}`).join(",")}|${sources}|${revisions === null ? "none" : `${revisions.readRevision}/${revisions.maintenanceRevision}`}`;
}

/**
 * Drive the bounded routing loop both stores share.
 *
 * Exhaustion is `input_stale` with no mutation, and each aborted attempt's
 * rollback metadata is carried onto the final refusal: a routing restart that
 * failed to roll back is still diagnosable after the write was refused.
 */
async function runRouted<R>(
  now: () => Date,
  deadline: number,
  attempt: () => Promise<RoutedAttempt<R>>
): Promise<R> {
  const conflicts: Error[] = [];
  for (let run = 1; run <= STRUCTURED_SCOPE_MAX_ROUTING_ATTEMPTS; run += 1) {
    assertLiveDeadline(deadline, now());
    try {
      const outcome = await attempt();
      if (outcome.kind === "committed") return outcome.value;
      conflicts.push(new ScopeRoutingConflict(`routing attempt ${run} discarded`));
    } catch (error) {
      if (!(error instanceof ScopeRoutingConflict)) throw error;
      conflicts.push(error);
    }
  }
  const exhausted = new StructuredScopeError(
    "input_stale",
    "ownership or the affected source set kept changing during routing; the write was refused without mutation"
  );
  for (const conflict of conflicts) {
    recordSuppressedFailure(exhausted, conflict);
  }
  throw exhausted;
}

/** Compose a scoped input view so both stores share the subset and filter rules. */
function createScopedInputView(input: {
  readonly context: AuthorizedScopeContext;
  readonly revisions: () => Promise<ScopeRevisionState | null>;
  readonly accepted: (
    refs: readonly string[],
    readRevision: number
  ) => Promise<AcceptedInputSnapshot>;
  readonly maintenance: (
    refs: readonly string[],
    maintenanceRevision: number
  ) => Promise<MaintenanceInputSnapshot>;
}): ScopedInputView {
  const { context, revisions, accepted, maintenance } = input;
  const revisionOf = async (
    pick: (state: ScopeRevisionState) => number
  ): Promise<number> => {
    const live = await revisions();
    if (live === null) {
      throw new StructuredScopeError(
        "maintenance_status_unavailable",
        "the trusted scope's revisions are not readable"
      );
    }
    return pick(live);
  };
  return {
    context,
    async readAcceptedInputs(requested) {
      const refs = requireAuthorizedSubset(context, requested);
      return accepted(refs, await revisionOf((state) => state.readRevision));
    },
    async readMaintenanceInputs(requested) {
      const refs = requireAuthorizedSubset(context, requested);
      return maintenance(
        refs,
        await revisionOf((state) => state.maintenanceRevision)
      );
    },
  };
}

/** The refusal a context that this authority never minted earns. */
function requireOwnContext(
  authority: AuthorizedScopeUnitOfWork,
  context: AuthorizedScopeContext
): AuthorizedScopeContext {
  if (scopeAuthorityOf(context) !== authority) {
    throw new StructuredScopeError(
      "access_denied",
      "the authorized scope context was not minted by this storage composition"
    );
  }
  return context;
}

/**
 * A stable ownership map that disagrees with the trusted context is a refusal,
 * not a restart: restarting would only re-read the same committed truth.
 *
 * The two refusals are different verdicts. A source nobody owns was never
 * granted to this context, so the run is denied; a source another scope owns is
 * a binding this scope cannot take at all, which is the same answer a second
 * concurrent owner gets.
 */
function assertContextOwnership(
  context: AuthorizedScopeContext,
  ownership: readonly SourceOwnership[],
  options?: AuthorizedScopeRunOptions
): void {
  const declaring = options?.authorizeNewSources === true;
  for (const entry of ownership) {
    if (entry.ownerScopeBinding === context.ownerScopeBinding) continue;
    if (declaring && entry.ownerScopeBinding === null) continue;
    throw new StructuredScopeError(
      entry.ownerScopeBinding === null
        ? "access_denied"
        : "unsupported_source_binding",
      `source ${entry.sourceRef} is not authorized in this trusted owner scope`
    );
  }
}

/**
 * Rows to lock after the owner scope. A declaration introduces sources no scope
 * owns yet; those rows do not exist, and the declaring transaction creates them
 * under the scope lock it already holds.
 */
function refsToLock(
  ownership: readonly SourceOwnership[],
  context: AuthorizedScopeContext,
  options?: AuthorizedScopeRunOptions
): string[] {
  const declaring = options?.authorizeNewSources === true;
  return ownership
    .filter(
      (entry) =>
        entry.ownerScopeBinding === context.ownerScopeBinding || !declaring
    )
    .map((entry) => entry.sourceRef);
}

/**
 * A source the trusted set named but that has since been withdrawn is stale
 * input rather than a lock to wait on: the committed truth no longer matches
 * the context, so the run refuses instead of writing past the withdrawal.
 */
function assertAuthorizedSourcesActive(
  lockedRows: readonly ScopedSourceInput[]
): void {
  for (const row of lockedRows) {
    if (!row.active) {
      throw new StructuredScopeError(
        "input_stale",
        `source ${row.sourceRef} is no longer active in the authorized scope`
      );
    }
  }
}

/** The authorization grant a run must still carry to write or read at all. */
function assertCurrentAuthorization(
  context: AuthorizedScopeContext,
  granted: string | null
): void {
  if (granted === context.authorizationRevision) return;
  throw new StructuredScopeError(
    "access_denied",
    granted === null
      ? "the trusted scope carries no authorization revision"
      : "the trusted scope's authorization changed after this context was minted"
  );
}

/**
 * The PostgreSQL seam: one pool client, one transaction, one lock order, one
 * commit.
 */
export class PgStructuredScopeUnitOfWork
  implements
    StructuredScopeUnitOfWork<AuthorizedScopeWork>,
    AuthorizedScopeUnitOfWork
{
  private readonly clock: () => Date;

  constructor(
    private readonly leaseClient: () => Promise<ScopeTransactionClient>,
    now: () => Date = () => new Date()
  ) {
    this.clock = now;
  }

  createAuthorizedContext(
    input: AuthorizedScopeContextInput
  ): AuthorizedScopeContext {
    return mintAuthorizedScopeContext(input, this);
  }

  /**
   * One client, one transaction, commit once, roll back once with diagnostics.
   *
   * A caller that publishes its own failure vocabulary supplies `fail` so the
   * error the transaction records its rollback metadata against stays the error
   * the caller throws: re-typing it afterwards would strand the diagnostics on
   * an object nobody receives.
   */
  async runTransaction<R>(
    body: (client: ScopeTransactionClient) => Promise<R>,
    options: {
      readonly readOnly?: boolean;
      readonly fail?: (error: unknown) => Error;
    } = {}
  ): Promise<R> {
    const client = await this.leaseClient();
    let started = false;
    try {
      await client.query(
        options.readOnly
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          : "BEGIN"
      );
      started = true;
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      const primary = options.fail
        ? options.fail(error)
        : structuredScopeError(error);
      await rollbackRetaining(client, primary, started);
      throw primary;
    } finally {
      client.release();
    }
  }

  async withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: AuthorizedScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R> {
    const trusted = requireOwnContext(this, context);
    const refs = affectedSourceRefs(trusted, options);
    const deadline = readDeadline(trusted.deadlineAt, this.clock);
    return runRouted(this.clock, deadline, () =>
      this.attemptAuthorizedRun(trusted, refs, deadline, callback, options)
    );
  }

  private async attemptAuthorizedRun<R>(
    context: AuthorizedScopeContext,
    refs: readonly string[],
    deadline: number,
    callback: (work: AuthorizedScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<RoutedAttempt<R>> {
    const client = await this.leaseClient();
    let started = false;
    const bumps: ScopeRevisionChange[] = [];
    try {
      await client.query("BEGIN");
      started = true;
      await this.routeOwnership(client, context, refs, options);
      const value = await callback({
        client,
        ...createScopedInputView({
          context,
          revisions: () =>
            currentScopeRevisions(client, context.ownerScopeBinding),
          accepted: (requested, readRevision) =>
            buildPgAcceptedSnapshot(client, context, requested, readRevision),
          maintenance: (requested, maintenanceRevision) =>
            buildPgMaintenanceSnapshot(
              client,
              context,
              requested,
              maintenanceRevision
            ),
        }),
        bumpRevisions: (change: ScopeRevisionChange) => {
          bumps.push(change);
        },
      });
      assertLiveDeadline(deadline, this.clock());
      // Deferred to this point so the counters move exactly once, after every
      // fallible step, and never for a transaction that is about to roll back.
      for (const change of bumps) {
        await advanceRevision(client, context.ownerScopeBinding, change);
      }
      await client.query("COMMIT");
      return { kind: "committed", value };
    } catch (error) {
      // Read the routing signal off the raw error. structuredScopeError()
      // re-types anything that is not already a StructuredScopeError, so a
      // ScopeRoutingConflict checked after that call would never match and the
      // bounded restart in runRouted could not fire: a contended ownership read
      // would surface as backend_unavailable instead of restarting.
      const restart = error instanceof ScopeRoutingConflict;
      const primary = structuredScopeError(error);
      await rollbackRetaining(client, primary, started);
      if (restart) return { kind: "restart" };
      throw primary;
    } finally {
      client.release();
    }
  }

  /**
   * Reserve, re-resolve, then lock in the unified order.
   *
   * Discovery is a separate lock-free transaction, so a source that changed
   * owner in between is genuinely observable here and the run restarts instead
   * of writing under a stale ownership map. The second resolution happens while
   * the reservations are held, which is what makes the map authoritative for the
   * owner and source locks that follow.
   */
  private async routeOwnership(
    client: ScopeTransactionClient,
    context: AuthorizedScopeContext,
    refs: readonly string[],
    options?: AuthorizedScopeRunOptions
  ): Promise<ScopeRevisionState | null> {
    const discovered = await this.runTransaction(
      (readClient) => resolveOwnership(readClient, refs),
      { readOnly: true }
    );
    if (!(await reserveSources(client, refs))) {
      throw new ScopeRoutingConflict("source reservation was contended");
    }
    const reserved = await resolveOwnership(client, refs);
    if (!sameOwnership(discovered, reserved)) {
      throw new ScopeRoutingConflict(
        "ownership changed between discovery and reservation"
      );
    }
    assertContextOwnership(context, reserved, options);
    assertCurrentAuthorization(
      context,
      await readScopeAuthorization(client, context.ownerScopeBinding)
    );
    const revisions = await lockOwnerScope(
      client,
      context.ownerScopeBinding,
      options?.authorizeNewSources === true
    );
    const lockedRows = await lockAffectedSources(
      client,
      context.ownerScopeBinding,
      refsToLock(reserved, context, options)
    );
    assertAuthorizedSourcesActive(lockedRows);
    return revisions;
  }
}

/** The in-memory authority the seam reads, supplied by the composed stores. */
export interface MemoryPublicationScopeAuthority {
  /** Owner scope for one source, resolved from the actual authoritative maps. */
  resolveOwnerScopeBinding(sourceRef: string): string | null;
  /** Live scope revisions, or null when the scope was never registered. */
  scopeRevisions(scopeBinding: string): ScopeRevisionState | null;
  /** Exact current rows for the requested sources inside one scope. */
  scopedSourceRows(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): readonly ScopedSourceInput[];
  /** Current serving membership rows for the requested sources. */
  scopedMembershipRows(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): readonly ScopedMembershipInput[];
  /** Published extraction rows and attributed values for the requested set. */
  scopedExtractionRows(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): readonly ScopedExtractionInput[];
  /** Advance the scope's revision counters. Synchronous by contract. */
  advanceScopeRevision(scopeBinding: string, change: ScopeRevisionChange): void;
}

/** The work ledger half of the memory authority. */
export interface MemoryWorkScopeAuthority {
  scopedWorkRecords(sourceRefs: readonly string[]): readonly ScopedWorkInput[];
}

/** The authorization grant half of the memory authority. */
export interface MemoryScopeAuthorizationAuthority {
  authorizationRevision(scopeBinding: string): string | null;
}

/** The one queue every accepted memory write cooperates on. */
export interface MemorySerializationPort {
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}

/**
 * A single serialization tail.
 *
 * It is a one-slot chain rather than a mutex because memory writes await an
 * outbox or extraction preparation: holding a synchronous lock across an await
 * would deadlock the event loop's only writer. Queuing here keeps the visible
 * effect identical — one writer at a time, in arrival order — while still
 * allowing preparation to be asynchronous.
 */
export class MemoryStructuredScopeTail implements MemorySerializationPort {
  private tail: Promise<void> = Promise.resolve();

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

/** One observation of the authority, taken with or without the tail held. */
interface MemoryObservation {
  readonly ownership: readonly SourceOwnership[];
  readonly rows: readonly ScopedSourceInput[];
  readonly revisions: ScopeRevisionState | null;
  readonly token: string;
}

/**
 * The memory seam: the same authority, the same bounded routing, and the same
 * typed exits as PostgreSQL, expressed as one shared tail plus prepare-then-
 * commit instead of locks.
 */
export class MemoryStructuredScopeUnitOfWork
  implements
    StructuredScopeUnitOfWork<PreparedMemoryScopeWork>,
    AuthorizedScopeUnitOfWork
{
  constructor(
    private readonly tail: MemorySerializationPort,
    private readonly publication: MemoryPublicationScopeAuthority,
    private readonly work: MemoryWorkScopeAuthority,
    private readonly authorization: MemoryScopeAuthorizationAuthority,
    private readonly now: () => Date = () => new Date()
  ) {}

  createAuthorizedContext(
    input: AuthorizedScopeContextInput
  ): AuthorizedScopeContext {
    return mintAuthorizedScopeContext(input, this);
  }

  /** The queue this seam shares with the publication and work stores. */
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.tail.exclusive(action);
  }

  async withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R> {
    const trusted = requireOwnContext(this, context);
    const refs = affectedSourceRefs(trusted, options);
    const deadline = readDeadline(trusted.deadlineAt, this.now);
    return runRouted(this.now, deadline, () =>
      this.attemptAuthorizedRun(trusted, refs, deadline, callback, options)
    );
  }

  /**
   * One attempt: discovery without the queue, validation in a queue slice, the
   * callback's awaits outside it, then a final slice whose checks and commit are
   * synchronous. Nothing becomes visible unless the authority still matches what
   * this attempt validated.
   */
  private async attemptAuthorizedRun<R>(
    context: AuthorizedScopeContext,
    refs: readonly string[],
    deadline: number,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<RoutedAttempt<R>> {
    const discovered = this.observe(context.ownerScopeBinding, refs);
    const held = await this.tail.exclusive(async () => {
      const reserved = this.observe(context.ownerScopeBinding, refs);
      if (reserved.token !== discovered.token) {
        throw new ScopeRoutingConflict(
          "ownership or scope state moved between discovery and reservation"
        );
      }
      this.validate(context, reserved, options);
      return reserved;
    });
    const prepared: (() => void)[] = [];
    const bumps: ScopeRevisionChange[] = [];
    const value = await callback({
      ...this.createInputs(context),
      prepare: (commit: () => void) => {
        if (typeof commit !== "function") {
          throw new StructuredScopeError(
            "invalid_input",
            "a prepared scope mutation must be a synchronous commit closure"
          );
        }
        prepared.push(commit);
      },
      bumpRevisions: (change: ScopeRevisionChange) => {
        bumps.push(change);
      },
    });
    return this.tail.exclusive(async () => {
      if (this.observe(context.ownerScopeBinding, refs).token !== held.token) {
        throw new ScopeRoutingConflict(
          "the authority accepted another write during preparation"
        );
      }
      // Everything fallible has happened; nothing after this point may await.
      assertLiveDeadline(deadline, this.now());
      for (const commit of prepared) commit();
      for (const change of bumps) {
        this.publication.advanceScopeRevision(context.ownerScopeBinding, change);
      }
      return { kind: "committed" as const, value };
    });
  }

  private observe(
    scopeBinding: string,
    refs: readonly string[]
  ): MemoryObservation {
    const ownership = refs.map((sourceRef) => ({
      sourceRef,
      ownerScopeBinding: this.publication.resolveOwnerScopeBinding(sourceRef),
    }));
    const rows = this.publication.scopedSourceRows(scopeBinding, refs);
    return {
      ownership,
      rows,
      revisions: this.publication.scopeRevisions(scopeBinding),
      token: fingerprint(
        ownership,
        rows,
        this.publication.scopeRevisions(scopeBinding)
      ),
    };
  }

  /**
   * Deny before writes: ownership, the current authorization grant, and the
   * existence and activity of every source the context claims to cover. A
   * source that left the set is a typed staleness refusal rather than a row the
   * view quietly omits, because omitting it would understate the corpus.
   */
  private validate(
    context: AuthorizedScopeContext,
    observed: MemoryObservation,
    options?: AuthorizedScopeRunOptions
  ): void {
    assertContextOwnership(context, observed.ownership, options);
    assertCurrentAuthorization(
      context,
      this.authorization.authorizationRevision(context.ownerScopeBinding)
    );
    const declaring = options?.authorizeNewSources === true;
    const present = new Set(observed.rows.map((row) => row.sourceRef));
    for (const sourceRef of context.authorizedSourceRefs) {
      if (present.has(sourceRef) || declaring) continue;
      throw new StructuredScopeError(
        "input_stale",
        `source ${sourceRef} is no longer in the trusted scope`
      );
    }
    if (!declaring && observed.rows.some((row) => !row.active)) {
      throw new StructuredScopeError(
        "input_stale",
        "a trusted source is no longer active in this owner scope"
      );
    }
    if (observed.revisions === null) {
      throw new StructuredScopeError(
        "access_denied",
        "trusted publication scope is not registered"
      );
    }
  }

  private createInputs(context: AuthorizedScopeContext): ScopedInputView {
    const rows = (refs: readonly string[]): ScopedSourceInput[] =>
      this.publication
        .scopedSourceRows(context.ownerScopeBinding, refs)
        .filter((row) => row.active);
    return createScopedInputView({
      context,
      revisions: async () =>
        this.publication.scopeRevisions(context.ownerScopeBinding),
      accepted: async (refs, readRevision) => {
        const sources = rows(refs);
        const visible = new Set(sources.map((row) => row.sourceRef));
        return {
          ownerScopeBinding: context.ownerScopeBinding,
          readerBinding: context.readerBinding,
          authorizationRevision: context.authorizationRevision,
          readRevision,
          sources,
          memberships: this.publication
            .scopedMembershipRows(context.ownerScopeBinding, refs)
            .filter((row) => visible.has(row.sourceRef)),
          extractions: this.publication
            .scopedExtractionRows(context.ownerScopeBinding, refs)
            .filter((row) => visible.has(row.sourceRef)),
        };
      },
      maintenance: async (refs, maintenanceRevision) => {
        const sources = rows(refs);
        const visible = new Set(sources.map((row) => row.sourceRef));
        return {
          ownerScopeBinding: context.ownerScopeBinding,
          readerBinding: context.readerBinding,
          authorizationRevision: context.authorizationRevision,
          maintenanceRevision,
          sources: sources.map(toMemoryMaintenanceSource),
          work: this.work
            .scopedWorkRecords(refs)
            .filter((record) => visible.has(record.sourceRef)),
        };
      },
    });
  }
}

function toMemoryMaintenanceSource(
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

/** Re-export the pieces adapters compose with, from one import target. */
export {
  advanceRevision,
  currentScopeRevisions,
  lockAffectedSources,
  lockOwnerScope,
  resolveOwnership,
  stableSourceRefs,
  StructuredScopeError,
};
export type { ScopeRevisionState };
export type {
  AcceptedInputSnapshot,
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeRunOptions,
  AuthorizedScopeUnitOfWork,
  AuthorizedScopeWork,
  MaintenanceInputSnapshot,
  PreparedMemoryScopeWork,
  ScopeRevisionChange,
  ScopeTransactionClient,
  ScopeWorkHandle,
  ScopedExtractionInput,
  ScopedInputView,
  ScopedMembershipInput,
  ScopedSourceInput,
  ScopedWorkInput,
  SourceOwnership,
};
