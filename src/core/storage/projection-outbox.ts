/**
 * projection_outbox writer — the ledger→Neo4j sync intent log
 * (specs/neo4j-graph-arm.md T2; ADR-0001).
 *
 * An intent names a SUBJECT that changed, never a snapshot of its values: the
 * projector re-reads the current row from Postgres (the only system of record)
 * when it drains, so intents need no ordering rule and cannot carry a stale
 * payload into Neo4j.
 *
 * Callers own the transaction. The extract CLI emits inside its per-chunk
 * `BEGIN … COMMIT`, so the intent and the ledger rows it describes commit or
 * roll back together; the backfill CLI emits outside one, where each intent is
 * independent. DDL lives in schema-projection.ts.
 *
 * The drain half of the lifecycle lives here too — claim, done, failed,
 * re-arm — so every statement against `projection_outbox` is in one file and
 * the CLI above it only decides flags, ordering and exit codes.
 */
import { randomUUID } from "node:crypto";

/** Subjects that may be projected. `chunk` is deliberately absent (ADR-0001). */
export type ProjectionSubjectKind = "entity" | "triple";

export interface ProjectionSubject {
  kind: ProjectionSubjectKind;
  id: string;
}

/**
 * Minimal query surface satisfied by `pg.Pool`, `pg.PoolClient` and the test
 * fakes. Declared here rather than imported from the extraction context so
 * storage does not depend on a sibling capability slice for a 1-line shape.
 */
export interface OutboxClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * `DO NOTHING` on the partial UNIQUE index (one undrained intent per subject):
 * a subject that is already queued needs no second intent, because the drain
 * reads its state fresh. Without it a repeat would abort the caller's
 * transaction — which for the extract path means losing the whole chunk.
 */
const EMIT_SQL = `INSERT INTO projection_outbox
     (id, subject_kind, subject_id, status)
   VALUES ($1, $2, $3, 'pending')
   ON CONFLICT (subject_kind, subject_id) WHERE status = 'pending'
   DO NOTHING`;

/**
 * Emit one pending intent per subject, in order, de-duplicated within the
 * call. Returns the number of rows actually queued (an already-pending
 * subject contributes 0).
 */
export async function emitProjectionIntents(
  client: OutboxClient,
  subjects: readonly ProjectionSubject[]
): Promise<number> {
  let queued = 0;
  for (const subject of dedupe(subjects)) {
    const { rows } = await client.query(`${EMIT_SQL} RETURNING id`, [
      randomUUID(),
      subject.kind,
      subject.id,
    ]);
    queued += rows.length;
  }
  return queued;
}

/** A claimed intent: which subject the drain must re-read and project. */
export interface OutboxIntent {
  id: string;
  subject: ProjectionSubject;
}

/**
 * Take the oldest pending intents for this drain run.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two concurrent drains safe: the
 * second one steps over the rows the first is holding instead of blocking on
 * them or projecting the same subject twice. The caller must already be inside
 * a transaction — the locks are what the claim is made of, so a claim outside
 * one would release them at once.
 *
 * Ordered `created_at, subject_kind`: within one extract transaction every
 * intent shares a `created_at` (Postgres `now()` is transaction time), and
 * 'entity' sorts before 'triple', so a chunk's nodes are claimed before its
 * edges. `id` only breaks the remaining ties, for a deterministic scan.
 */
export async function claimPendingIntents(
  client: OutboxClient,
  limit: number
): Promise<OutboxIntent[]> {
  const { rows } = await client.query(
    `SELECT id, subject_kind, subject_id
       FROM projection_outbox
      WHERE status = 'pending'
      ORDER BY created_at, subject_kind, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit]
  );
  return rows.map((row) => ({
    id: row.id as string,
    subject: {
      kind: row.subject_kind as ProjectionSubjectKind,
      id: row.subject_id as string,
    },
  }));
}

/**
 * The intents in this batch reached Neo4j. `attempts` counts attempts, not
 * failures, so it advances here too — an intent that needed three runs to land
 * says so. `last_error` is cleared: it described an attempt that is now over.
 */
export async function markIntentsDone(
  client: OutboxClient,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await client.query(
    `UPDATE projection_outbox
        SET status = 'done', attempts = attempts + 1,
            last_error = NULL, processed_at = now()
      WHERE id = ANY($1::uuid[])
      RETURNING id`,
    [[...ids]]
  );
  return rows.length;
}

/** Longest `last_error` kept. A driver stack trace is not triage material. */
const MAX_ERROR_CHARS = 500;

/**
 * The batch did not reach Neo4j. Recording `failed` rather than leaving the
 * rows pending is deliberate: a subject the graph rejects every time would
 * otherwise sit at the head of the queue forever, and SC4 asks for failures to
 * be visible. `attempts` + `last_error` are the visibility; `--retry-failed`
 * is the way back to pending.
 */
export async function markIntentsFailed(
  client: OutboxClient,
  ids: readonly string[],
  error: string
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await client.query(
    `UPDATE projection_outbox
        SET status = 'failed', attempts = attempts + 1,
            last_error = $2, processed_at = now()
      WHERE id = ANY($1::uuid[])
      RETURNING id`,
    [[...ids], error.slice(0, MAX_ERROR_CHARS)]
  );
  return rows.length;
}

/**
 * Move failed intents back to pending so the next drain retries them.
 *
 * Two guards keep the partial UNIQUE index (at most one pending intent per
 * subject) intact — violating it would abort the whole re-arm:
 *   - `DISTINCT ON` re-arms only the newest failed intent per subject, since a
 *     subject can fail, be re-emitted, and fail again;
 *   - the NOT EXISTS drops subjects that already have a pending intent, which
 *     is a retry the queue is going to make anyway.
 * The intents left behind stay `failed` and visible; nothing is deleted.
 */
export async function reArmFailedIntents(
  client: OutboxClient
): Promise<number> {
  const { rows } = await client.query(
    `WITH newest AS (
       SELECT DISTINCT ON (subject_kind, subject_id) id
         FROM projection_outbox
        WHERE status = 'failed'
        ORDER BY subject_kind, subject_id, created_at DESC, id
     )
     UPDATE projection_outbox o
        SET status = 'pending', last_error = NULL, processed_at = NULL
       FROM newest n
      WHERE o.id = n.id
        AND NOT EXISTS (
          SELECT 1 FROM projection_outbox p
           WHERE p.subject_kind = o.subject_kind
             AND p.subject_id = o.subject_id
             AND p.status = 'pending')
      RETURNING o.id`,
    []
  );
  return rows.length;
}

/** Queue depth per status, for the drain's `--dry-run` report. */
export async function countIntentsByStatus(
  client: OutboxClient
): Promise<Record<string, number>> {
  const { rows } = await client.query(
    `SELECT status, count(*)::int AS count
       FROM projection_outbox
      GROUP BY status`,
    []
  );
  const counts: Record<string, number> = { pending: 0, done: 0, failed: 0 };
  for (const row of rows) counts[row.status as string] = Number(row.count);
  return counts;
}

/** First occurrence wins; keeps the caller's order for a readable query log. */
function dedupe(subjects: readonly ProjectionSubject[]): ProjectionSubject[] {
  const seen = new Set<string>();
  const out: ProjectionSubject[] = [];
  for (const subject of subjects) {
    const key = `${subject.kind}:${subject.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(subject);
  }
  return out;
}
