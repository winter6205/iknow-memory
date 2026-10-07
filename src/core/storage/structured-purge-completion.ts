/**
 * The slice of MP17's completion module that MP15 needs: the ADR 0099 §2.1
 * `collected` write, at client level.
 *
 * **This file is a partial copy of branch `feat/p3-mp17-completion`, commit
 * `2ffbb96`.** MP15 needs `recordPayloadCollection` because ADR 0099 §2.1 makes
 * `collected` true only in the SAME COMMIT as the payload removal, and only the
 * deletion transaction can guarantee that. It is copied rather than
 * re-derived so the two branches cannot disagree about the guard's monotonicity.
 * The rest of MP17's module — `readConfiguredOwners`, `schedulePurgeCompletion`,
 * `readPurgeCompletion`, `recordOwnerScrub` and `PgPurgeCompletionReconciler` —
 * is deliberately absent here: when fin merges MP15 with MP17 this file becomes
 * MP17's file whole, and adding those five exports now would mean two branches
 * editing one symbol.
 *
 * The `structured_purge_outcomes` DDL it needs is copied verbatim alongside in
 * `schema-structured-completion.ts`, so MP17's own bootstrap adds nothing and
 * the merge is a no-op on the schema.
 *
 * PG-only, with no in-memory twin: the property this write exists for — that it
 * lands in one commit with a DELETE — is a property of the database.
 * `structured-purge-pg.ts:38-41` is the precedent.
 */
import {
  StructuredScopeError,
} from "./structured-scope-types.js";

/**
 * The minimal client surface, satisfied by a transaction client and by a test
 * fake. Every statement here is a value-parameterised query, so nothing in this
 * module builds SQL from a caller-supplied string.
 */
export interface PurgeCompletionClient {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * The one scope purge revision this call reconciles.
 *
 * Exported so the refusal is provable without a database: a blank scope or
 * revision names no record, and every statement below is keyed on exactly these
 * two values.
 */
export interface PurgeCompletionKey {
  readonly scopeBinding: string;
  readonly purgeRevision: string;
}

/**
 * Record that the backend's own payload is gone, for the revision MP15 is
 * collecting.
 *
 * **A client-level write on purpose.** ADR 0099 §2.1 makes `collected` true only
 * in the same commit as the payload removal, so this cannot own a transaction: it
 * has to be called from inside the delete transaction that removed the rows, or
 * the two facts could diverge in exactly the direction that matters — a record
 * claiming collection while the payload is still there.
 *
 * The guard is monotonic (`collected_at IS NULL`) so a second collector pass
 * cannot move the instant, and it deliberately does NOT touch `completed_at`:
 * ADR 0099 §2.4a's writer separation means this statement has no completion to
 * write even when every owner has already scrubbed.
 */
export async function recordPayloadCollection(
  client: PurgeCompletionClient,
  key: PurgeCompletionKey
): Promise<boolean> {
  const key2 = requireKey(key);
  const { rows } = await client.query(
    `UPDATE structured_purge_outcomes
        SET collection_state = 'collected', collected_at = now()
      WHERE scope_binding = $1 AND purge_revision = $2
        AND collected_at IS NULL
      RETURNING collected_at`,
    [key2.scopeBinding, key2.purgeRevision]
  );
  return rows.length === 1;
}

/**
 * One refusal rule for the revision key.
 *
 * Reused rather than restated, for the same reason `structured-purge-pg.ts:154-161`
 * reuses `requirePublicationString`: two copies of "a key must be a non-blank
 * string" is two rules one of them will forget, and this is the key every
 * statement in the module is filtered on.
 */
function requireKey(key: PurgeCompletionKey): PurgeCompletionKey {
  return {
    scopeBinding: requireKeyToken(key?.scopeBinding, "scopeBinding"),
    purgeRevision: requireKeyToken(key?.purgeRevision, "purgeRevision"),
  };
}

function requireKeyToken(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StructuredScopeError(
      "invalid_input",
      `${field} must be a non-blank string`
    );
  }
  return value.trim();
}