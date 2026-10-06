/**
 * PostgreSQL persistence for guarded screening decisions.
 *
 * The decision runs inside the shared authorized scope unit of work, so it takes
 * the same locks in the same order as screening and publication and commits
 * once. That is what makes "a refused decision makes no change" and "a
 * visibility change is atomic with its intent" true rather than merely
 * intended: the decision row, the visibility rows it applies, the projection
 * intents and the revision advance are one transaction, and every refusal
 * before that point leaves nothing behind for a separate connection to find.
 *
 * The fence against two decisions racing is the same one screening and
 * publication already use: the candidate row is locked `FOR UPDATE` before it is
 * read, so the second decision sees the first one's visibility rows rather than
 * the state both were written against. Nothing here keeps a private copy of
 * conflict state to compare against.
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
  type AuthorizedScopeWork,
  type StructuredScopeFailureCode,
} from "./structured-scope-types.js";
import { emitProjectionIntents } from "./projection-outbox.js";

/** The seam this adapter runs under; composition supplies it exactly once. */
export interface ScreeningDecisionAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: AuthorizedScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

export interface PgApplyDecisionInput {
  readonly request: ScreeningDecisionRequest;
  /** The conflict the decision addresses, as this store holds it. */
  readonly facts: ScreeningConflictFacts;
  readonly additionalSourceRefs?: readonly string[];
}

interface DecisionRow {
  readonly decision_id: string;
  readonly scope_binding: string;
  readonly candidate_id: string;
  readonly check_id: string;
  readonly outcome: string;
  readonly reason: string;
  readonly actor_id: string;
  readonly retire_support_ids: string[];
  readonly retain_support_ids: string[];
  readonly assertion_ids: string[];
  readonly expected_input_revision: string;
  readonly expected_relation_catalog_version: string | number;
  readonly content_digest: string;
  readonly decided_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function refusalError(
  code: StructuredScopeFailureCode,
  detail: string
): StructuredScopeError {
  return new StructuredScopeError(code, detail);
}

function refusalCodeOf(
  refusal: "access_denied" | "invalid_input" | "input_stale"
): StructuredScopeFailureCode {
  return DECISION_REFUSAL_CODES[refusal];
}

async function databaseNow(
  client: AuthorizedScopeWork["client"]
): Promise<Date> {
  const { rows } = await client.query("SELECT clock_timestamp() AS instant");
  const value = (rows[0] as { instant?: Date | string } | undefined)?.instant;
  if (value === undefined || Number.isNaN(new Date(value).getTime())) {
    // EXIT: the database clock returned nothing readable. The decision throws
    // `backend_unavailable` rather than stamping a decision with a process
    // clock, because its decided_at is provenance a second machine's time would
    // misattribute.
    throw new StructuredScopeError(
      "backend_unavailable",
      "database clock did not return a valid instant"
    );
  }
  return new Date(value);
}

/** Both scope revisions as they read after this transaction's own advance. */
async function readRevisions(
  client: AuthorizedScopeWork["client"],
  scopeBinding: string
): Promise<{ readonly read: number; readonly maintenance: number }> {
  const { rows } = await client.query(
    `SELECT read_revision, maintenance_revision
       FROM structured_publication_scopes WHERE scope_binding = $1`,
    [scopeBinding]
  );
  const row = rows[0] as
    | { read_revision?: string; maintenance_revision?: string }
    | undefined;
  if (row === undefined) {
    // EXIT: the scope row the decision advanced no longer reads back. The
    // decision throws rather than reporting an effect at a revision it cannot
    // confirm, and the unit of work rolls the whole decision back.
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "the decision's scope revision is not readable after the advance"
    );
  }
  return {
    read: Number(row.read_revision ?? 0),
    maintenance: Number(row.maintenance_revision ?? 0),
  };
}

function toRecord(row: DecisionRow): ScreeningDecisionRecord {
  return {
    decisionId: row.decision_id,
    scopeBinding: row.scope_binding,
    candidateId: row.candidate_id,
    checkId: row.check_id,
    outcome: row.outcome as ScreeningDecisionRecord["outcome"],
    reason: row.reason,
    actorId: row.actor_id,
    retireSupportIds: row.retire_support_ids,
    retainSupportIds: row.retain_support_ids,
    assertionIds: row.assertion_ids,
    expectedInputRevision: row.expected_input_revision,
    expectedRelationCatalogVersion: Number(
      row.expected_relation_catalog_version
    ),
    decidedAt: toIso(row.decided_at),
    contentDigest: row.content_digest,
  };
}

/** PostgreSQL guarded screening decisions, bound to the shared scope UOW. */
export class PgScreeningDecisionStorage {
  constructor(private readonly scope: ScreeningDecisionAuthority) {}

  /**
   * Apply one explicit decision, or refuse typed with nothing written.
   *
   * The lock on the candidate row is taken before the conflict is read, so two
   * decisions presented against the same expected revisions are serialized: the
   * second one reads the first one's effect and refuses rather than resolving
   * the same conflict twice.
   */
  async applyDecision(
    input: PgApplyDecisionInput
  ): Promise<ScreeningDecisionOutcomeRecord> {
    return this.scope.withAuthorizedScope(
      input.request.context as AuthorizedScopeContext,
      async (work) => {
        const client = work.client;
        const now = await databaseNow(client);
        const candidate = await client.query(
          `SELECT check_id, support_ids, assertion_ids, input_revision,
                  relation_catalog_version
             FROM structured_screening_candidates
            WHERE candidate_id = $1 AND scope_binding = $2
            FOR UPDATE`,
          [input.request.candidateId, input.facts.scopeBinding]
        );
        const row = candidate.rows[0] as
          | {
              check_id?: string;
              support_ids?: string[];
              assertion_ids?: string[];
              input_revision?: string;
              relation_catalog_version?: number;
            }
          | undefined;
        if (row === undefined) {
          // EXIT: the decision names a conflict this scope does not hold. It
          // throws `invalid_input` before the lock on anything else, so a
          // decision against an unknown conflict writes nothing.
          throw refusalError(
            "invalid_input",
            `no screening candidate ${input.request.candidateId} in scope ${input.facts.scopeBinding}`
          );
        }
        const facts: ScreeningConflictFacts = {
          scopeBinding: input.facts.scopeBinding,
          candidateId: input.request.candidateId,
          checkId: row.check_id ?? "",
          supportIds: row.support_ids ?? [],
          assertionIds: row.assertion_ids ?? [],
          inputRevision: row.input_revision ?? "",
          relationCatalogVersion: row.relation_catalog_version ?? 0,
          readRevision: input.facts.readRevision,
          maintenanceRevision: input.facts.maintenanceRevision,
        };
        const validation = validateDecisionRequest(input.request, facts);
        if (!validation.ok) {
          // EXIT: the decision is not applicable to the conflict as the store
          // holds it. It throws the refusal's own class and the unit of work
          // rolls back, so the candidate, its visibility rows, the outbox and
          // both revisions are exactly as they were.
          throw refusalError(refusalCodeOf(validation.refusal), validation.detail);
        }
        const decidedAt = now.toISOString();
        const contentDigest = decisionContentDigest(input.request);
        const prior = await client.query(
          `SELECT ${DECISION_COLUMNS}
             FROM structured_screening_decisions
            WHERE decision_id = $1
            FOR UPDATE`,
          [input.request.decisionId]
        );
        const priorRow = prior.rows[0] as DecisionRow | undefined;
        if (priorRow !== undefined && priorRow.content_digest !== contentDigest) {
          // EXIT: the decision id is already recorded with different content.
          // It throws `invalid_input` rather than overwriting the recorded
          // decision, because an evidence row a later submission could rewrite
          // would not be evidence of what was decided.
          throw refusalError(
            "invalid_input",
            `decision ${input.request.decisionId} is already recorded with different content`
          );
        }
        const resolvedBy = await client.query(
          `SELECT decision_id FROM structured_screening_decisions
            WHERE scope_binding = $1 AND candidate_id = $2
              AND decision_id <> $3
            ORDER BY decided_at, decision_id
            FOR UPDATE`,
          [
            input.facts.scopeBinding,
            input.request.candidateId,
            input.request.decisionId,
          ]
        );
        if (resolvedBy.rows.length > 0) {
          // EXIT: a different decision already resolved this conflict. The
          // decision refuses as `input_stale` rather than applying a second
          // outcome over the first, because the state its author read — an
          // unresolved conflict — no longer exists. The candidate row is
          // already locked, so two decisions presented together are serialized
          // and the loser reads this and refuses.
          throw refusalError(
            "input_stale",
            `conflict ${input.request.candidateId} was already resolved by decision ${String(
              (resolvedBy.rows[0] as { decision_id?: string }).decision_id
            )}`
          );
        }
        if (priorRow !== undefined) {
          // An identical resubmission is the same decision, not a second one.
          // The effect was applied by the first submission; returning the
          // recorded decision at the CURRENT revisions is what makes a retry
          // safe, and re-applying nothing is what keeps it from advancing a
          // revision twice.
          const revisions = await readRevisions(
            client,
            input.facts.scopeBinding
          );
          return {
            decision: toRecord(priorRow),
            effect: {
              decisionId: priorRow.decision_id,
              candidateId: priorRow.candidate_id,
              outcome: priorRow.outcome as ScreeningDecisionRecord["outcome"],
              retireSupportIds: priorRow.retire_support_ids,
              retainSupportIds: priorRow.retain_support_ids,
              assertionIds: priorRow.assertion_ids,
              visibilityChanged: outcomeChangesVisibility(
                priorRow.outcome as ScreeningDecisionRecord["outcome"]
              ),
              projectionIntentsEnqueued: false,
              readRevision: revisions.read,
              maintenanceRevision: revisions.maintenance,
            },
            idempotent: true,
          };
        }
        await client.query(
          `INSERT INTO structured_screening_decisions
             (decision_id, scope_binding, candidate_id, check_id, outcome, reason,
              actor_id, retire_support_ids, retain_support_ids, assertion_ids,
              expected_input_revision, expected_relation_catalog_version,
              content_digest, decided_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14)`,
          [
            input.request.decisionId,
            input.facts.scopeBinding,
            input.request.candidateId,
            facts.checkId,
            input.request.outcome,
            input.request.reason,
            input.request.context.actorId,
            JSON.stringify([...input.request.retireSupportIds]),
            JSON.stringify([...input.request.retainSupportIds]),
            JSON.stringify([...input.request.assertionIds]),
            input.request.expectedInputRevision,
            input.request.expectedRelationCatalogVersion,
            contentDigest,
            decidedAt,
          ]
        );
        const retired = new Set(input.request.retireSupportIds);
        const retained = new Set(input.request.retainSupportIds);
        const currentBySupport = new Map<string, boolean>();
        for (const supportId of facts.supportIds) {
          currentBySupport.set(supportId, !retired.has(supportId));
        }
        for (const supportId of retained) currentBySupport.set(supportId, true);
        for (const [supportId, current] of currentBySupport) {
          await client.query(
            `INSERT INTO structured_screening_conflict_visibility
               (scope_binding, candidate_id, support_id, assertion_id, current,
                resolved_by, outcome, decided_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (scope_binding, candidate_id, support_id)
             DO UPDATE SET current = EXCLUDED.current,
                           resolved_by = EXCLUDED.resolved_by,
                           outcome = EXCLUDED.outcome,
                           decided_at = EXCLUDED.decided_at`,
            [
              input.facts.scopeBinding,
              input.request.candidateId,
              supportId,
              input.request.assertionIds[0] ?? "",
              current,
              input.request.decisionId,
              input.request.outcome,
              decidedAt,
            ]
          );
        }
        const visibilityChanged = outcomeChangesVisibility(input.request.outcome);
        let intentsEnqueued = false;
        if (visibilityChanged) {
          // A visibility change enqueues the affected projection intents in the
          // same commit as the visibility rows, so a drain can never read a
          // retired support as current or miss a retirement that already
          // happened. `keep_both` enqueues nothing, because it changed nothing.
          await emitProjectionIntents(
            client,
            input.request.assertionIds.map((id) => ({
              kind: "triple" as const,
              id,
            }))
          );
          // Whether an intent was QUEUED is not the observable: the outbox
          // de-duplicates against subjects another transaction already has
          // pending, so a row count would report this decision's effect as
          // absent for a subject it did address. What is observable, and what
          // this decision must guarantee, is that every affected subject holds
          // a pending intent after this commit.
          const { rows: pending } = await client.query(
            `SELECT subject_id FROM projection_outbox
              WHERE subject_kind = 'triple' AND status = 'pending'
                AND subject_id::text = ANY($1::text[])`,
            [[...input.request.assertionIds]]
          );
          intentsEnqueued =
            pending.length === input.request.assertionIds.length &&
            input.request.assertionIds.length > 0;
        }
        work.bumpRevisions({
          read: visibilityChanged,
          maintenance: true,
        });
        const revisions = await readRevisions(
          client,
          input.facts.scopeBinding
        );
        const decision: ScreeningDecisionRecord = {
          decisionId: input.request.decisionId,
          scopeBinding: input.facts.scopeBinding,
          candidateId: input.request.candidateId,
          checkId: facts.checkId,
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
            projectionIntentsEnqueued: intentsEnqueued,
            readRevision: revisions.read,
            maintenanceRevision: revisions.maintenance,
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
  async readDecisions(
    client: AuthorizedScopeWork["client"],
    scopeBinding: string,
    candidateId?: string
  ): Promise<ScreeningDecisionRecord[]> {
    const { rows } = await client.query(
      `SELECT ${DECISION_COLUMNS}
         FROM structured_screening_decisions
        WHERE scope_binding = $1
          AND ($2::text IS NULL OR candidate_id = $2)
        ORDER BY decided_at, decision_id`,
      [scopeBinding, candidateId ?? null]
    );
    return rows.map((row) => toRecord(row as DecisionRow));
  }

  /** Whether this conflict still reads as unresolved, by explicit decision. */
  async readConflictResolution(
    client: AuthorizedScopeWork["client"],
    scopeBinding: string,
    candidateId: string
  ): Promise<boolean> {
    return conflictIsResolved(
      await this.readDecisions(client, scopeBinding, candidateId),
      candidateId
    );
  }
}

const DECISION_COLUMNS = `decision_id, scope_binding, candidate_id, check_id,
  outcome, reason, actor_id, retire_support_ids, retain_support_ids,
  assertion_ids, expected_input_revision, expected_relation_catalog_version,
  content_digest, decided_at`;
