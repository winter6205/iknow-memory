/**
 * MP15 resumable deletion — the in-memory lane.
 *
 * **It does NOT compose through `withAuthorizedScope`, and that is the plan's
 * recorded decision, not an omission.** The UoW's admission check refuses any
 * run whose trusted sources are inactive (`assertAuthorizedSourcesActive`,
 * structured-scope-uow.ts:853-858) — and MP15 deletes retired AND withdrawn
 * payloads, so an inactive row is this capability's normal case, not an edge.
 * Bypassing the read-admission assertion is not a hole: the same authority
 * still supplies the one serialization tail this store drives directly, the
 * ownership fence (`requireOwnedScope` below) still runs, and the eligibility
 * re-read happens INSIDE the tail slice — mark, version facts, live grants and
 * revision are read there — so a payload protected between the mark and the
 * delete is still refused before any row moves. The PG lane is MP16's route:
 * `PgScopeTransactionRunner` directly, with the same shared lock order.
 *
 * **The store owns no payload state.** Versions, supports, extractions, grant
 * pins, locators and binding caches live in the backend the lane is composed
 * over; marks live in the mark storage; revisions live in the publication
 * authority. The store composes them through the narrow evidence surface
 * (`collection-delete-evidence.ts`) and holds only the per-(version, revision)
 * progress rows its resume contract owns. That composition is what makes the
 * resume case real rather than simulated: a *fresh store instance* — the
 * in-memory stand-in for the process that picked up a crashed run — reads the
 * same backend, marks and publication objects, so it sees a previous
 * instance's phases and stamp without any cross-instance seeding, and
 * `readPayloadCollectedAt` goes to the backend for the same reason.
 *
 * One `exclusive` slice wraps the whole run, because the memory lane has no
 * transaction to roll back: the slice IS the atomicity. A crash window is not
 * representable here, so the M16 resume case seeds the progress row a crashed
 * attempt leaves behind and proves a fresh instance rejoins it; the real
 * crash-resume proof is the PG acceptance lane.
 *
 * The verdicts are not re-derived here: every accept or refuse is
 * `planCollectionDelete`, so a disagreement between the lanes can only be
 * about persistence and ordering, never about what the answer should have
 * been. Evidence-side failures inside the slice throw
 * `CollectionDeleteEvidenceError`, which this store re-raises unchanged — the
 * caller sees the typed code, not an empty success.
 */
import {
  planCollectionDelete,
  remainingDeletePhases,
  COLLECTION_DELETE_PHASES,
  type CollectionDeleteOutcome,
  type CollectionDeletePhase,
  type CollectionDeletePlan,
  type CollectionDeleteRequest,
} from "../maintenance/collection-delete.js";
import type { CollectionMark } from "../maintenance/collection-mark-types.js";
import type {
  CollectionPayloadClass,
} from "../maintenance/collector-types.js";
import type { MaintenanceWorkFailureCode } from "../maintenance/types.js";
import type {
  AuthorizedScopeContext,
  MemorySerializationPort,
  ScopeRevisionState,
} from "./structured-scope-types.js";
import type {
  InMemoryCollectionMarkStorage,
} from "./collection-mark-memory.js";
import type {
  CollectionDeleteEvidenceSurface,
  CollectionDeleteSharedReferences,
} from "./collection-delete-evidence.js";
import type { MemoryPublicationScopeAuthority } from "./structured-scope-uow.js";

/** The per-phase progress row a committed attempt records (M16's resume key). */
export interface InMemoryDeleteProgressRow {
  sourceVersionId: string;
  purgeRevision: string;
  committedPhases: CollectionDeletePhase[];
  collected: boolean;
  collectedAt?: string;
}

/**
 * Everything the lane holds across attempts. Payload rows live in the composed
 * backend; only the progress rows are the store's own.
 */
export interface InMemoryCollectionDeleteSeed {
  readonly progress?: readonly InMemoryDeleteProgressRow[];
}

/** One phase's row-count, as the outcome reports it. */
export type MemoryDeleteRowCounts = Record<CollectionDeletePhase, number>;

/**
 * What one accepted deletion committed.
 *
 * `sharedReferences` is the exact live-reference count on the two "original
 * content" columns, per plan §Shared-object key: REPORTED, never gating, and
 * the statement is keyed on `source_version_id` throughout.
 */
export interface MemoryCollectionDeleteResult {
  readonly deleted: boolean;
  readonly sourceVersionId: string;
  readonly purgeRevision: string;
  /** The phases THIS call ran, in order. A resumed call runs the tail only. */
  readonly phasesRun: readonly CollectionDeletePhase[];
  /** Rows removed per phase, so a resumed step's work is observable. */
  readonly phaseCounts: MemoryDeleteRowCounts;
  readonly sharedReferences: CollectionDeleteSharedReferences;
  readonly deadlineAt: string;
  /** The stamp instant, present exactly when this call took the payload terminal. */
  readonly collectedAt: string | null;
}

/**
 * The one shape every exit in this lane returns — the MP13/MP14 refusal
 * vocabulary on one arm, the committed result on the other.
 */
export type MemoryCollectionDeleteOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | {
      readonly refused: false;
      readonly outcome: MemoryCollectionDeleteResult;
    };

/** One deletion, as the caller knows it. */
export interface MemoryCollectionDeleteRequest {
  readonly context: AuthorizedScopeContext;
  /** The scope the mark belongs to; it must be the context's owner scope. */
  readonly scopeBinding: string;
  readonly identity: {
    readonly payloadClass: CollectionPayloadClass;
    readonly payloadRef: string;
  };
  /** The MP16 tombstone revision this deletion collects under. */
  readonly purgeRevision: string;
}

/**
 * The stores one delete lane composes over. Injected, not constructed: the
 * resumed instance receives the SAME objects the original instance held, which
 * is what makes cross-instance visibility a property of the real stores and
 * not of a seeding ritual.
 */
export interface InMemoryCollectionDeleteDeps {
  /**
   * The serialization tail. The PG lane takes `PgScopeTransactionRunner`
   * directly for the same reason this is the raw tail and not the UoW's
   * `withAuthorizedScope`: the admission check would refuse the inactive rows
   * MP15 exists to delete.
   */
  readonly serialization: MemorySerializationPort;
  /** MP14's mark storage; the run withdraws the mark through it. */
  readonly marks: InMemoryCollectionMarkStorage;
  /** The narrow evidence surface the backend implements (collection-delete-evidence.ts). */
  readonly evidence: CollectionDeleteEvidenceSurface;
  /** The publication authority the run reads the revision from and advances. */
  readonly publication: MemoryPublicationScopeAuthority;
}

export class InMemoryCollectionDeleteStore {
  private readonly progress = new Map<string, InMemoryDeleteProgressRow>();

  constructor(
    private readonly deps: InMemoryCollectionDeleteDeps,
    private readonly now: () => Date = () => new Date(),
    seed: InMemoryCollectionDeleteSeed = {}
  ) {
    for (const row of seed.progress ?? []) {
      this.progress.set(progressKey(row.sourceVersionId, row.purgeRevision), {
        ...row,
      });
    }
  }

  /**
   * Delete one marked payload in dependency order, resuming from any progress a
   * previous attempt recorded.
   *
   * One exclusive slice wraps read, decide, mutate and advance. Everything
   * fallible happens before the first mutation, and every refusal below returns
   * a value with no mutation applied — the guarantee a memory lane offers in
   * place of a rollback.
   */
  async deleteCollectionPayload(
    request: MemoryCollectionDeleteRequest
  ): Promise<MemoryCollectionDeleteOutcome> {
    return this.deps.serialization.exclusive(async () => {
      const owned = requireOwnedScope(request.context, request.scopeBinding);
      if (owned !== null) return owned;

      // The eligibility re-read, INSIDE the slice: mark, version facts, live
      // grants and revision are one read of the world the decision consumes.
      // The evidence surface answers the version-side questions from the
      // backend — the same maps every other structured writer commits to —
      // so what the plan sees here is what a retry would see.
      const markRow = await this.deps.marks.readCollectionMark(
        request.identity
      );
      const sourceVersionId = markRow?.sourceVersionId ?? null;
      const now = this.now();
      const facts =
        sourceVersionId === null
          ? { bindingResolved: false, payloadCollected: false, liveRowGrants: [] }
          : await this.deps.evidence.readCollectionDeleteFacts({
              sourceVersionId,
              now,
            });
      const revision = this.readRevision(request.scopeBinding);

      const outcome: CollectionDeleteOutcome = planCollectionDelete(
        this.deleteRequest(request),
        {
          mark: markRow,
          lifecycleRevision: revision,
          bindingResolved: facts.bindingResolved,
          payloadCollected: facts.payloadCollected,
          liveRowGrants: facts.liveRowGrants,
          now,
        }
      );
      if (outcome.refused) return outcome;

      const plan: CollectionDeletePlan = outcome.plan;
      const progress = this.readProgress(
        plan.sourceVersionId,
        plan.purgeRevision
      );
      if (progress?.collected) {
        // ADR 0099 §2.1: collected is monotonic. A retry after completion is
        // refused as stale rather than re-stamped or re-deleted.
        return {
          refused: true,
          code: "input_stale",
          detail: `payload ${request.identity.payloadRef} was already collected for purge revision ${plan.purgeRevision}`,
        };
      }

      return this.applyDelete(request, plan, progress?.committedPhases ?? []);
    });
  }

  /**
   * The mutation half of an accepted delete: the phases, the terminal step and
   * the revision advance, in ADR 0099 §2.1's order. The slice is already held,
   * every fallible read has happened, and the refusals are done — this is the
   * commit side the memory lane runs in place of a rollback.
   */
  private async applyDelete(
    request: MemoryCollectionDeleteRequest,
    plan: CollectionDeletePlan,
    committed: readonly CollectionDeletePhase[]
  ): Promise<MemoryCollectionDeleteOutcome> {
    const phases = remainingDeletePhases(committed);

    const counts: MemoryDeleteRowCounts = zeroCounts();
    for (const phase of phases) {
      counts[phase] = await this.deps.evidence.deleteCollectionPhase(phase, {
        sourceVersionId: plan.sourceVersionId,
      });
    }

    // The terminal step, only after every phase ran: the mark row is
    // withdrawn, then `payload_collected_at` is stamped — same slice, after
    // the removal, never before, never instead (ADR 0099 §2.1).
    this.deps.marks.deleteCollectionMark(request.identity);
    const collectedAt = this.now().toISOString();
    await this.deps.evidence.collectSourceVersionPayload(
      plan.sourceVersionId,
      collectedAt
    );

    this.progress.set(progressKey(plan.sourceVersionId, plan.purgeRevision), {
      sourceVersionId: plan.sourceVersionId,
      purgeRevision: plan.purgeRevision,
      committedPhases: [...COLLECTION_DELETE_PHASES],
      collected: true,
      collectedAt,
    });
    // The deletion is as maintenance-visible as the mark that stopped the
    // obligations: the scope moves once, after every fallible step.
    this.deps.publication.advanceScopeRevision(request.scopeBinding, {
      read: false,
      maintenance: true,
    });

    return {
      refused: false,
      outcome: {
        deleted: true,
        sourceVersionId: plan.sourceVersionId,
        purgeRevision: plan.purgeRevision,
        phasesRun: phases,
        phaseCounts: counts,
        sharedReferences: await this.deps.evidence.countSharedVersionReferences(
          plan.sourceVersionId
        ),
        deadlineAt: plan.deadlineAt,
        collectedAt,
      },
    };
  }

  /**
   * The stamp, read from the backend — never from a store-private copy — so a
   * caller of the original instance sees a resumed instance's stamp.
   */
  async readPayloadCollectedAt(sourceVersionId: string): Promise<string | null> {
    return this.deps.evidence.readPayloadCollectedAt(sourceVersionId);
  }

  /** The mark as the mark storage holds it, or null. */
  async readCollectionMark(identity: {
    payloadClass: CollectionPayloadClass;
    payloadRef: string;
  }): Promise<CollectionMark | null> {
    return this.deps.marks.readCollectionMark(identity);
  }

  /** The phases a (version, revision) pair has already committed, for resume. */
  async readCommittedPhases(
    sourceVersionId: string,
    purgeRevision: string
  ): Promise<readonly CollectionDeletePhase[]> {
    const row = this.progress.get(progressKey(sourceVersionId, purgeRevision));
    return row === undefined ? [] : [...row.committedPhases];
  }

  private deleteRequest(
    request: MemoryCollectionDeleteRequest
  ): CollectionDeleteRequest {
    return {
      identity: request.identity,
      scopeBinding: request.scopeBinding,
      purgeRevision: request.purgeRevision,
    };
  }

  private readProgress(
    sourceVersionId: string,
    purgeRevision: string
  ): InMemoryDeleteProgressRow | null {
    return (
      this.progress.get(progressKey(sourceVersionId, purgeRevision)) ?? null
    );
  }

  /**
   * The scope's live maintenance revision, read inside the slice. The PG lane's
   * observedRevision raises the same refusal for an unregistered scope — the
   * delete cannot name a revision in a scope that has none.
   */
  private readRevision(scopeBinding: string): string {
    const revisions: ScopeRevisionState | null =
      this.deps.publication.scopeRevisions(scopeBinding);
    if (revisions === null) {
      throw new Error(
        `scope ${scopeBinding} is not registered, so no collection delete can name a revision in it`
      );
    }
    return String(revisions.maintenanceRevision);
  }
}

function zeroCounts(): MemoryDeleteRowCounts {
  return {
    dependent_supports: 0,
    extraction_payloads: 0,
    assertion_supports: 0,
    frozen_units: 0,
    superseded_caches: 0,
  };
}

function progressKey(sourceVersionId: string, purgeRevision: string): string {
  return `${sourceVersionId}|${purgeRevision}`;
}

/** A context is authority over one owner scope; a request may not name another. */
function requireOwnedScope(
  context: AuthorizedScopeContext,
  scopeBinding: string
): {
  readonly refused: true;
  readonly code: "access_denied";
  readonly detail: string;
} | null {
  if (scopeBinding === context.ownerScopeBinding) return null;
  return {
    refused: true,
    code: "access_denied",
    detail: `the delete scope ${scopeBinding} is not the context's owner scope ${context.ownerScopeBinding}`,
  };
}
