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
