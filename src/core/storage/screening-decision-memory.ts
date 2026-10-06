/**
 * In-memory guarded screening decisions, the twin of `screening-decision-pg.ts`.
 *
 * It runs on the same shared serialization tail as screening and publication,
 * so a decision commit cannot land between another writer's last validation and
 * its commit. Validation happens during preparation; the decision, its
 * visibility rows and the outbox intents are written in the seam's synchronous
 * commit slice with no await between them, which is the all-or-nothing
 * property the PostgreSQL transaction gives, expressed without a rollback.
 *
 * The conflict facts are read from the authoritative maps inside the same
 * exclusive slice, never from a private copy taken earlier: a decision that
 * raced another writer would otherwise compare against a state that had
 * already moved.
 */
import {
  conflictIsResolved,
  DECISION_REFUSAL_CODES,
  decisionContentDigest,
  outcomeChangesVisibility,
  validateDecisionRequest,
  type ScreeningConflictFacts,
  type ScreeningDecisionOutcomeRecord,
  type ScreeningDecisionRecord,
  type ScreeningDecisionRequest,
} from "../maintenance/screening-decision.js";
import {
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeRunOptions,
  type PreparedMemoryScopeWork,
} from "./structured-scope-types.js";
import type { PublicationOutboxPort } from "../maintenance/publication-types.js";

/** The seam this adapter runs under. */
export interface MemoryScreeningDecisionAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

export interface MemoryApplyDecisionInput {
  readonly request: ScreeningDecisionRequest;
  readonly facts: ScreeningConflictFacts;
  readonly additionalSourceRefs?: readonly string[];
  /**
   * The clock the decision's `decidedAt` is stamped from. It arrives from the
   * lane rather than from `Date.now()` so the recorded decision time is the
   * same controlled instant the rest of the lane runs on.
   */
  readonly now: () => Date;
}

export interface MemoryDecisionVisibility {
  readonly supportId: string;
  readonly current: boolean;
  readonly resolvedBy: string;
  /** The `<candidateId>|<supportId>` the row belongs to; set on scope reads. */
  readonly conflict?: string;
}

export interface MemoryDecisionOutboxIntent {
  readonly kind: "triple";
  readonly id: string;
}

/** The authoritative state one decision reads and writes, as the lane holds it. */
export interface MemoryDecisionLedgerPort {
  /** The conflict exactly as the screening store published it. */
  readConflict(
    scopeBinding: string,
    candidateId: string
  ):
    | {
        readonly checkId: string;
        readonly supportIds: readonly string[];
        readonly assertionIds: readonly string[];
        readonly inputRevision: string;
        readonly relationCatalogVersion: number;
      }
    | undefined;
  /** The scope's revisions as they read inside the exclusive slice. */
  readRevisions(scopeBinding: string): { readonly read: number; readonly maintenance: number };
  /** Prepare the commit closure that records the decision and its effect. */
  prepareCommit(commit: () => void): void;
}

function visibilityKey(
  scopeBinding: string,
  candidateId: string,
  supportId: string
): string {
  return `${scopeBinding}|${candidateId}|${supportId}`;
}

function refusalError(
  code: "access_denied" | "invalid_input" | "input_stale",
  detail: string
): StructuredScopeError {
  return new StructuredScopeError(DECISION_REFUSAL_CODES[code], detail);
}

/** In-memory guarded screening decisions. */
export class MemoryScreeningDecisionStorage {
  private readonly decisions = new Map<string, ScreeningDecisionRecord>();
  private readonly visibility = new Map<string, MemoryDecisionVisibility>();

  constructor(
    private readonly scope: MemoryScreeningDecisionAuthority,
    private readonly ledger: MemoryDecisionLedgerPort,
    private readonly outbox?: PublicationOutboxPort
  ) {}

  /** Apply one explicit decision, or refuse typed with nothing written. */
  async applyDecision(
    input: MemoryApplyDecisionInput
  ): Promise<ScreeningDecisionOutcomeRecord> {
    return this.scope.withAuthorizedScope(
      input.request.context as AuthorizedScopeContext,
      async (work) => {
        const conflict = this.ledger.readConflict(
          input.facts.scopeBinding,
          input.request.candidateId
        );
        if (conflict === undefined) {
          // EXIT: the decision names a conflict this scope does not hold. It
          // throws before any commit closure is prepared, so nothing is
          // written and the lane's authoritative maps are untouched.
          throw refusalError(
            "invalid_input",
            `no screening candidate ${input.request.candidateId} in scope ${input.facts.scopeBinding}`
          );
        }
        const facts: ScreeningConflictFacts = {
          scopeBinding: input.facts.scopeBinding,
          candidateId: input.request.candidateId,
          checkId: conflict.checkId,
          supportIds: conflict.supportIds,
          assertionIds: conflict.assertionIds,
          inputRevision: conflict.inputRevision,
          relationCatalogVersion: conflict.relationCatalogVersion,
          readRevision: input.facts.readRevision,
          maintenanceRevision: input.facts.maintenanceRevision,
        };
        const validation = validateDecisionRequest(input.request, facts);
        if (!validation.ok) {
          // EXIT: the decision is not applicable to the conflict as the store
          // holds it. It throws the refusal's own class and no commit closure
          // has been prepared, so the decision, the visibility rows, the
          // outbox and both revisions are exactly as they were.
          throw refusalError(validation.refusal, validation.detail);
        }
        const contentDigest = decisionContentDigest(input.request);
        const prior = this.decisions.get(input.request.decisionId);
        if (prior !== undefined && prior.contentDigest !== contentDigest) {
          // EXIT: the decision id is already recorded with different content.
          // It throws rather than overwriting, because an evidence row a later
          // submission could rewrite would not be evidence of what was decided.
          throw refusalError(
            "invalid_input",
            `decision ${input.request.decisionId} is already recorded with different content`
          );
        }
        const priorResolver = [...this.decisions.values()].find(
          (decision) =>
            decision.scopeBinding === input.facts.scopeBinding &&
            decision.candidateId === input.request.candidateId &&
            decision.decisionId !== input.request.decisionId
        );
        if (priorResolver !== undefined) {
          // EXIT: a different decision already resolved this conflict. The
          // decision refuses as `input_stale` rather than applying a second
          // outcome over the first. The shared serialization tail means the
          // second decision reads this only after the first committed, which is
          // what makes two racing decisions unable to both apply.
          throw refusalError(
            "input_stale",
            `conflict ${input.request.candidateId} was already resolved by decision ${priorResolver.decisionId}`
          );
        }
        const decidedAt = input.now().toISOString();
        if (prior !== undefined) {
          // An identical resubmission is the same decision, not a second one:
          // the recorded decision is returned at the CURRENT revisions and
          // nothing is applied, so a retry cannot advance a revision twice.
          const revisions = this.ledger.readRevisions(input.facts.scopeBinding);
          return {
            decision: prior,
            effect: {
              decisionId: prior.decisionId,
              candidateId: prior.candidateId,
              outcome: prior.outcome,
              retireSupportIds: prior.retireSupportIds,
              retainSupportIds: prior.retainSupportIds,
              assertionIds: prior.assertionIds,
              visibilityChanged: outcomeChangesVisibility(prior.outcome),
              projectionIntentsEnqueued: false,
              readRevision: revisions.read,
              maintenanceRevision: revisions.maintenance,
            },
            idempotent: true,
          };
        }
        const decision: ScreeningDecisionRecord = {
          decisionId: input.request.decisionId,
          scopeBinding: input.facts.scopeBinding,
          candidateId: input.request.candidateId,
          checkId: conflict.checkId,
          outcome: input.request.outcome,
          reason: input.request.reason,
          actorId: input.request.context.actorId,
          retireSupportIds: [...input.request.retireSupportIds],
          retainSupportIds: [...input.request.retainSupportIds],
          assertionIds: [...input.request.assertionIds],
          expectedInputRevision: input.request.expectedInputRevision,
          expectedRelationCatalogVersion:
            input.request.expectedRelationCatalogVersion,
          decidedAt,
          contentDigest,
        };
        const retired = new Set(input.request.retireSupportIds);
        const retained = new Set(input.request.retainSupportIds);
        const currentBySupport = new Map<string, boolean>();
        for (const supportId of conflict.supportIds) {
          currentBySupport.set(supportId, !retired.has(supportId));
        }
        for (const supportId of retained) currentBySupport.set(supportId, true);
        const visibilityChanged = outcomeChangesVisibility(decision.outcome);
        const intentCommit =
          visibilityChanged && this.outbox !== undefined
            ? await this.outbox.prepareIntents(
                input.facts.scopeBinding,
                decision.assertionIds.map((id) => ({
                  kind: "triple" as const,
                  id,
                }))
              )
            : null;
        work.bumpRevisions({ read: visibilityChanged, maintenance: true });
        const revisions = this.ledger.readRevisions(input.facts.scopeBinding);
        // The seam advances the scope revisions in its own commit slice, which
        // runs after this callback returns, so the revisions this decision
        // reports are the ones it is about to commit to rather than the ones
        // still on the books.
        const committed = {
          read: revisions.read + (visibilityChanged ? 1 : 0),
          maintenance: revisions.maintenance + 1,
        };
        work.prepare(() => {
          this.decisions.set(decision.decisionId, decision);
          for (const [supportId, current] of currentBySupport) {
            this.visibility.set(
              visibilityKey(
                input.facts.scopeBinding,
                input.request.candidateId,
                supportId
              ),
              { supportId, current, resolvedBy: decision.decisionId }
            );
          }
          // The intents are committed inside the same closure as the visibility
          // rows, so a drain can never see a retirement that did not commit or
          // miss one that did.
          intentCommit?.();
        });
        return {
          decision,
          effect: {
            decisionId: decision.decisionId,
            candidateId: decision.candidateId,
            outcome: decision.outcome,
            retireSupportIds: decision.retireSupportIds,
            retainSupportIds: decision.retainSupportIds,
            assertionIds: decision.assertionIds,
            visibilityChanged,
            projectionIntentsEnqueued: intentCommit !== null,
            readRevision: committed.read,
            maintenanceRevision: committed.maintenance,
          },
          idempotent: false,
        };
      },
      input.additionalSourceRefs === undefined
        ? undefined
        : { additionalSourceRefs: input.additionalSourceRefs }
    );
  }

  /** Every decision this scope holds for one conflict, oldest first. */
  readDecisions(scopeBinding: string, candidateId?: string): ScreeningDecisionRecord[] {
    return [...this.decisions.values()]
      .filter(
        (decision) =>
          decision.scopeBinding === scopeBinding &&
          (candidateId === undefined || decision.candidateId === candidateId)
      )
      .sort(
        (left, right) =>
          left.decidedAt === right.decidedAt
            ? left.decisionId.localeCompare(right.decisionId)
            : left.decidedAt.localeCompare(right.decidedAt)
      );
  }

  /** Whether this conflict still reads as unresolved, by explicit decision. */
  readConflictResolution(scopeBinding: string, candidateId: string): boolean {
    return conflictIsResolved(this.readDecisions(scopeBinding), candidateId);
  }

  /** The current visibility one decision gave each support in the conflict. */
  readVisibility(
    scopeBinding: string,
    candidateId: string
  ): MemoryDecisionVisibility[] {
    return [...this.visibility.entries()]
      .filter(([key]) => key.startsWith(`${scopeBinding}|${candidateId}|`))
      .map(([, value]) => value)
      .sort((left, right) => left.supportId.localeCompare(right.supportId));
  }

  /**
   * Every visibility row this scope holds, across all of its conflicts.
   *
   * A fingerprint of "nothing changed" has to cover the whole scope rather than
   * one conflict: a decision that leaked an effect onto a different conflict
   * would be invisible to a per-conflict read.
   */
  readScopeVisibility(scopeBinding: string): MemoryDecisionVisibility[] {
    return [...this.visibility.entries()]
      .filter(([key]) => key.startsWith(`${scopeBinding}|`))
      .map(([key, value]) => ({
        supportId: value.supportId,
        current: value.current,
        resolvedBy: value.resolvedBy,
        conflict: key.slice(`${scopeBinding}|`.length),
      }))
      .sort((left, right) => left.conflict.localeCompare(right.conflict));
  }
}
