/**
 * Embedding generation rotate T4 — fill / cutover / rollback / drop
 * (specs/embedding-generation.md assumptions 3 + 5–7 and the cutover,
 * downtime, rollback and drop success criteria).
 *
 * One rotate moves all three vector classes together, so these operations
 * flip or clear a SINGLE ledger pointer instead of touching per-table state
 * — that is what makes the flip atomic. Every pointer write runs under the
 * singleton's row lock (`FOR UPDATE`), so a concurrent second CLI cannot
 * interleave a count between one run's fill and its flip.
 *
 * Doctrine inherited from T1: slot names are machine-generated and pass
 * `assertEmbeddingSlotIdentifier` before any interpolation; refusals are
 * typed `GraphragError`s with `// EXIT:` notes; the live column is never
 * dropped implicitly — removal is this module's explicit `dropInactiveSlot`
 * step only.
 *
 * `client` is the same any-query-capable seam as in embedding-generation;
 * the transactional helpers must receive a DEDICATED client (a leased
 * PoolClient / pg.Client), never a shared Pool.
 */
import { GraphragError } from "../errors.js";
import { computeEntityEmbeddingText } from "../entities/embedding.js";
import type { SlotEmbeddingSource } from "../embed-slots.js";
import type { EmbeddingClient } from "../embedder.js";
import type {
  EmbeddingGenerationPair,
  EmbeddingGenerationState,
} from "../types.js";
import {
  ROTATION_TABLES,
  assertEmbeddingSlotIdentifier,
  readGenerationState,
  sameGenerationPair,
  slotIndexName,
  type RotationTable,
} from "./embedding-generation.js";
import { ConfigError } from "../../config.js";
import type { SchemaBootstrapClient } from "./schema-bootstrap.js";

/** Rows per fill scan batch; mirrors the backfill CLIs' page sizes. */
const DEFAULT_FILL_BATCH = 50;

/**
 * One ledger transaction: BEGIN, take the singleton row lock, run, COMMIT;
 * any typed error surfaces unchanged after ROLLBACK, anything else is
 * wrapped as STORAGE_ERROR (same doctrine as `openRotate`).
 */
async function inLedgerTransaction(
  client: SchemaBootstrapClient,
  run: () => Promise<void>
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT 1 FROM embedding_generation WHERE id = 1 FOR UPDATE"
    );
    await run();
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof GraphragError || err instanceof ConfigError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new GraphragError(
      `embedding rotate failed: ${message} (rolled back; ledger intact)`,
      "STORAGE_ERROR"
    );
    // EXIT: the transaction boundary is the safety story; a raw driver
    // failure must not look like a half-applied pointer move.
  }
}

/** The singleton read shared by all four operations; null is fatal here. */
async function requireRotateState(
  client: SchemaBootstrapClient
): Promise<EmbeddingGenerationState> {
  const state = await readGenerationState(client);
  if (state === null) {
    throw new GraphragError(
      "embedding rotate: no embedding_generation singleton — boot the backend once first",
      "STORAGE_ERROR"
    );
    // EXIT: every T4 operation needs a generation pointer to move.
  }
  return state;
}

/**
 * Per-class fill plan: which rows still miss the incoming slot, which
 * columns identify them, and how to rebuild their embed text from STORED
 * ledger facts only (ADR-0003: rebuild-from-ledger-text — never a CAST of
 * old floats and never a re-parse of the original 资料).
 */
interface TableFillPlan {
  table: RotationTable;
  /** Columns a fill scan needs; `id` first, then the embed-text sources. */
  selectColumns: string;
  /** Predicate for "this row still misses the incoming slot". */
  missingPredicate(slot: string): string;
  textOf(row: Record<string, unknown>): string;
}

const FILL_PLANS: readonly TableFillPlan[] = [
  {
    table: "chunks",
    selectColumns: "id, content",
    missingPredicate: (slot) => `${slot} IS NULL`,
    textOf: (row) => String(row.content ?? ""),
  },
  {
    table: "entities",
    selectColumns:
      "id, canonical_name, coalesce(metadata->>'description','') AS description",
    // Retired entities are never searchable, so their incoming column may
    // stay NULL forever — cutover completeness must not demand them.
    missingPredicate: (slot) => `retired = false AND ${slot} IS NULL`,
    textOf: (row) =>
      computeEntityEmbeddingText(
        String(row.canonical_name ?? ""),
        String(row.description ?? "")
      ),
  },
  {
    table: "community_summaries",
    selectColumns: "id, summary",
    missingPredicate: (slot) => `${slot} IS NULL`,
    textOf: (row) => String(row.summary ?? ""),
  },
];

/** Cutover moves the pointer once for all three tables: active ⇐ incoming, rollback ⇐ old active. */
const CUTOVER_FLIP_SQL = `UPDATE embedding_generation
   SET active_slot = incoming_slot,
       active_model = incoming_model,
       active_dimensions = incoming_dimensions,
       rollback_slot = active_slot,
       rollback_model = active_model,
       rollback_dimensions = active_dimensions,
       incoming_slot = NULL,
       incoming_model = NULL,
       incoming_dimensions = NULL,
       rotate_mode = NULL,
       updated_at = now()
 WHERE id = 1`;

/**
 * Rollback is a SWAP, not a clear (decision beyond the literal brief): the
 * displaced new generation stays tracked in rollback_*, so a second
 * `rollback` re-cuts over, and `drop` can still find the inactive column.
 * Clearing it would strand an untracked vector column per table.
 */
const ROLLBACK_SWAP_SQL = `UPDATE embedding_generation
   SET active_slot = rollback_slot,
       active_model = rollback_model,
       active_dimensions = rollback_dimensions,
       rollback_slot = active_slot,
       rollback_model = active_model,
       rollback_dimensions = active_dimensions,
       updated_at = now()
 WHERE id = 1`;

/** After every inactive column is dropped, nothing inactive remains to track. */
const DROP_CLEAR_SQL = `UPDATE embedding_generation
   SET incoming_slot = NULL,
       incoming_model = NULL,
       incoming_dimensions = NULL,
       rotate_mode = NULL,
       rollback_slot = NULL,
       rollback_model = NULL,
       rollback_dimensions = NULL,
       updated_at = now()
 WHERE id = 1`;

async function countMissingIncoming(
  client: SchemaBootstrapClient,
  plan: TableFillPlan,
  slot: string
): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS missing FROM ${plan.table} WHERE ${plan.missingPredicate(slot)}`
  );
  return Number((result.rows[0] as { missing?: number | string } | undefined)?.missing ?? 0);
}

/**
 * Cutover: flip active to the incoming generation for ALL three classes in
 * ONE row-locked transaction — but only when each class is completely
 * embedded toward the incoming slot (entities restrict to retired=false;
 * an empty table is trivially complete). Any gap refuses with the typed
 * first-incomplete class and its missing count, leaving the ledger
 * untouched; reads never observe a half-moved store.
 */
export async function cutoverRotate(
  client: SchemaBootstrapClient
): Promise<EmbeddingGenerationState> {
  await inLedgerTransaction(client, async () => {
    const state = await requireRotateState(client);
    if (state.incomingSlot === null || state.incoming === null) {
      throw new GraphragError(
        "cutover refused: no rotate is open (incoming slot absent)",
        "INVALID_INPUT"
      );
      // EXIT: nothing to cut over to.
    }
    if (state.rollbackSlot !== null) {
      throw new GraphragError(
        `cutover refused: the previous generation's slot ${state.rollbackSlot} ` +
          `still awaits its drop — run drop first`,
        "INVALID_INPUT"
      );
      // EXIT: flipping now would overwrite rollback_* and strand that column.
    }
    assertEmbeddingSlotIdentifier(state.incomingSlot);
    for (const plan of FILL_PLANS) {
      const missing = await countMissingIncoming(client, plan, state.incomingSlot);
      if (missing > 0) {
        throw new GraphragError(
          `cutover refused: ${plan.table} still has ${missing} rows without ` +
            `${state.incomingSlot} embeddings — run fill`,
          "INVALID_INPUT"
        );
        // EXIT: names the FIRST incomplete class + count (spec assumption 7).
      }
    }
    await client.query(CUTOVER_FLIP_SQL);
  });
  return requireRotateState(client);
}

/**
 * Rollback after a cutover: swap active back to the displaced generation.
 * Allowed only while rollback_slot is recorded and no new rotate is open;
 * pre-cutover there is nothing to roll back (typed refuse).
 */
export async function rollbackRotate(
  client: SchemaBootstrapClient
): Promise<EmbeddingGenerationState> {
  await inLedgerTransaction(client, async () => {
    const state = await requireRotateState(client);
    if (state.rollbackSlot === null || state.rollback === null) {
      throw new GraphragError(
        "rollback refused: no cutover is on record — nothing to roll back",
        "INVALID_INPUT"
      );
      // EXIT: rollback only exists downstream of cutover.
    }
    if (state.incomingSlot !== null) {
      throw new GraphragError(
        `rollback refused: a rotate toward ${state.incomingSlot} is still open — cut it over or drop it first`,
        "INVALID_INPUT"
      );
      // EXIT: swapping under an open rotate would lose the incoming pointer.
    }
    assertEmbeddingSlotIdentifier(state.rollbackSlot);
    assertEmbeddingSlotIdentifier(state.activeSlot);
    await client.query(ROLLBACK_SWAP_SQL);
  });
  return requireRotateState(client);
}

export interface FillSummary {
  perTable: Record<RotationTable, { scanned: number; filled: number }>;
}

export interface FillIncomingOptions {
  batchSize?: number;
}

/** The env embedder covers the incoming pair when the boot guard says env == it. */
function embedderForIncoming(
  source: SlotEmbeddingSource,
  incoming: EmbeddingGenerationPair
): EmbeddingClient {
  return sameGenerationPair(source.desired, incoming)
    ? source.embedder
    : source.buildEmbedder(incoming);
}

interface FillTableArgs {
  client: SchemaBootstrapClient;
  plan: TableFillPlan;
  slot: string;
  pair: EmbeddingGenerationPair;
  embedder: EmbeddingClient;
  batchSize: number;
}

async function fillOneTable(args: FillTableArgs): Promise<{
  scanned: number;
  filled: number;
}> {
  const { client, plan, slot, pair, embedder, batchSize } = args;
  let scanned = 0;
  let filled = 0;
  for (;;) {
    const result = await client.query(
      `SELECT ${plan.selectColumns} FROM ${plan.table} WHERE ${plan.missingPredicate(slot)} ORDER BY id LIMIT $1`,
      [batchSize]
    );
    const rows = result.rows as Record<string, unknown>[];
    scanned += rows.length;
    if (rows.length > 0) {
      const vectors = await embedder.embed(rows.map((row) => plan.textOf(row)));
      const literals = vectors.map((vector) => {
        if (vector.length !== pair.dimensions) {
          throw new GraphragError(
            `fill refused: embedder returned ${vector.length} dims for ${plan.table} but incoming slot ${slot} is vector(${pair.dimensions})`,
            "EMBEDDING_DIM_MISMATCH"
          );
          // EXIT: every width is checked BEFORE the first write (both-or-neither).
        }
        return `[${vector.join(",")}]`;
      });
      for (const [index, row] of rows.entries()) {
        // Guarded + RETURNING: a concurrent dual-write that filled the row
        // first wins, and this run counts it as not-filled.
        const updated = await client.query(
          `UPDATE ${plan.table} SET ${slot} = $2::vector WHERE id = $1 AND ${slot} IS NULL RETURNING id`,
          [row.id, literals[index]]
        );
        if (updated.rows.length > 0) filled += 1;
      }
    }
    if (rows.length < batchSize) return { scanned, filled };
  }
}

/**
 * Embed every row whose INCOMING slot is still NULL, per class, from stored
 * ledger text with the INCOMING pair's embedder (spec assumption 6). Writes
 * touch the incoming column only, are guarded on IS NULL (idempotent: a
 * second run scans and fills 0), and commit per row like the existing
 * backfills — an interrupted fill simply resumes. Refuses typed when no
 * rotate is open.
 */
export async function fillIncoming(
  client: SchemaBootstrapClient,
  source: SlotEmbeddingSource,
  options: FillIncomingOptions = {}
): Promise<FillSummary> {
  const batchSize = options.batchSize ?? DEFAULT_FILL_BATCH;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new GraphragError(
      `fillIncoming: batchSize must be a positive integer, got ${batchSize}`,
      "INVALID_INPUT"
    );
    // EXIT: input contract — checked before any query touches the store.
  }
  const state = await requireRotateState(client);
  if (state.incomingSlot === null || state.incoming === null) {
    throw new GraphragError(
      "fill refused: no rotate is open — nothing to fill toward",
      "INVALID_INPUT"
    );
    // EXIT: without an incoming slot there is no target column.
  }
  const slot = state.incomingSlot;
  assertEmbeddingSlotIdentifier(slot);
  const embedder = embedderForIncoming(source, state.incoming);
  const perTable = {} as FillSummary["perTable"];
  for (const plan of FILL_PLANS) {
    perTable[plan.table] = await fillOneTable({
      client,
      plan,
      slot,
      pair: state.incoming,
      embedder,
      batchSize,
    });
  }
  return { perTable };
}

export interface DropResult {
  droppedSlots: string[];
}

/**
 * Drop every INACTIVE slot on record — the aborted rotate's incoming and/or
 * a cutover-displaced rollback generation — across all three tables, then
 * clear those ledger fields. With nothing recorded this is a documented
 * no-op (exit-0, no DDL), so re-running drop is safe. The ACTIVE column is
 * never a target: a ledger naming active as inactive is corrupt and refuses
 * typed rather than destroying the live vectors.
 */
export async function dropInactiveSlot(
  client: SchemaBootstrapClient
): Promise<DropResult> {
  const dropped: string[] = [];
  await inLedgerTransaction(client, async () => {
    const state = await requireRotateState(client);
    const targets = [state.incomingSlot, state.rollbackSlot].filter(
      (slot): slot is string => slot !== null
    );
    // No-op contract: nothing inactive on record, nothing to do.
    if (targets.length === 0) return;
    if (targets.includes(state.activeSlot)) {
      throw new GraphragError(
        `drop refused: ${state.activeSlot} is the ACTIVE slot — corrupt ledger, refusing to drop live vectors`,
        "STORAGE_ERROR"
      );
      // EXIT: pointer rot must never reach the column reads depend on.
    }
    for (const slot of targets) {
      assertEmbeddingSlotIdentifier(slot);
      for (const table of ROTATION_TABLES) {
        await client.query(`DROP INDEX IF EXISTS ${slotIndexName(table, slot)}`);
        await client.query(
          `ALTER TABLE ${table} DROP COLUMN IF EXISTS ${slot}`
        );
      }
      dropped.push(slot);
    }
    await client.query(DROP_CLEAR_SQL);
  });
  return { droppedSlots: dropped };
}
