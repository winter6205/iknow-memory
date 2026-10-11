/**
 * Embedding-generation ledger (embedding generation rotate T1;
 * specs/embedding-generation.md).
 *
 * The `embedding_generation` singleton records which PHYSICAL vector column
 * is the active generation and, while a rotate is open, the incoming slot
 * plus its (model, dimensions). Generation identity is the pair
 * (model, dimensions): two generations can never share one cosine index, so
 * a rotate adds a NEW column + a NEW HNSW index per class instead of
 * casting or dropping in place.
 *
 * This module owns the ledger reads, the boot seed/refuse guard, and
 * `openRotate`. Cutover / rollback / drop and the dual-write / read-binding
 * consumers are later tickets (T2–T4) — they read the same state shape.
 *
 * Like schema-bootstrap, `client` is any query-capable handle; `openRotate`
 * runs DDL inside one transaction, so its caller must pass a DEDICATED
 * client (a leased PoolClient / pg.Client), not a shared Pool.
 */
import { ConfigError, readPgvectorAnnMaxDimensions } from "../../config.js";
import { GraphragError } from "../errors.js";
import {
  isEmbedRotateMode,
  type EmbeddingGenerationPair,
  type EmbeddingGenerationState,
  type EmbedRotateMode,
} from "../types.js";
import { hostnameHash } from "../../config/host-hash.js";
import {
  assertPgvectorAnnDimensions,
  type SchemaBootstrapClient,
} from "./schema-bootstrap.js";

/** Legacy physical column name — the generation every pre-ledger store has. */
export const EMBEDDING_SLOT_BASE = "embedding";

/** The three vector classes one rotate moves together. */
export const ROTATION_TABLES = [
  "chunks",
  "entities",
  "community_summaries",
] as const;

export type RotationTable = (typeof ROTATION_TABLES)[number];

/**
 * What the operator setting asks the store to hold: the configured embed
 * model (undefined when no embedding key is configured) and dimensions.
 */
export interface DesiredEmbeddingGeneration {
  model: string | undefined;
  dimensions: number;
  /** Effective embed base URL. Only its normalized hostname is compared. */
  embedBaseUrl?: string;
}

function toPair(desired: DesiredEmbeddingGeneration): EmbeddingGenerationPair {
  return { model: desired.model ?? null, dimensions: desired.dimensions };
}

/** Generation equality: an absent configured model equals a NULL recorded one. */
export function sameGenerationPair(
  a: EmbeddingGenerationPair,
  b: EmbeddingGenerationPair
): boolean {
  return (
    (a.model ?? null) === (b.model ?? null) && a.dimensions === b.dimensions
  );
}

function pairLabel(pair: EmbeddingGenerationPair): string {
  return `model=${pair.model ?? "none"} dims=${pair.dimensions}`;
}

/** Deterministic per-table index name for a physical slot. */
export function slotIndexName(table: RotationTable, slot: string): string {
  return `${table}_${slot}_idx`;
}

/**
 * Slot names reach DDL as PLAIN identifiers, so every call site funnels
 * through this validator first: only the legacy base name or the
 * machine-generated `embedding_gN` family may ever be interpolated.
 */
function assertSafeSlot(slot: string): void {
  if (slot === EMBEDDING_SLOT_BASE || /^embedding_g[1-9]\d*$/.test(slot)) {
    return;
  }
  throw new GraphragError(
    `embedding-generation: unsafe slot identifier "${slot}"`,
    "STORAGE_ERROR"
  );
  // EXIT: identifiers are machine-generated; anything else is corruption.
}

/** Public seam for T2 write sites that interpolate a slot column into DML. */
export function assertEmbeddingSlotIdentifier(slot: string): void {
  assertSafeSlot(slot);
}

/**
 * Read-side slot binding (T3): THE single point every vector read resolves
 * the physical column with — the ledger's ACTIVE slot, legacy `embedding`
 * for a pre-ledger store, typed refusal for a corrupt identifier. T4's
 * cutover/downtime paths reuse this same function; no read site may
 * interpolate a slot it has not passed through here first.
 */
export function activeSlotForRead(
  state: EmbeddingGenerationState | null | undefined
): string {
  const slot = state?.activeSlot ?? EMBEDDING_SLOT_BASE;
  assertSafeSlot(slot);
  return slot;
}

interface GenerationRow {
  active_slot: string;
  active_model: string | null;
  active_dimensions: number;
  incoming_slot: string | null;
  incoming_model: string | null;
  incoming_dimensions: number | null;
  rotate_mode: string | null;
  // Rollback columns are T4 additions; a pre-T4 deployed row lacks them,
  // which reads as "no cutover on record" rather than corruption.
  rollback_slot?: string | null;
  rollback_model?: string | null;
  rollback_dimensions?: number | null;
  embed_host_hash?: string | null;
  updated_at: Date;
}

/**
 * Downtime read refuse (T4, spec assumption 7): while a `downtime` rotate
 * is open the store is deliberately half-embedded toward the incoming
 * slot, and a partial cosine result would be indistinguishable from a
 * complete one — so every vector READ refuses with the typed named
 * failure BEFORE issuing SQL. Placed beside `activeSlotForRead` because
 * both are the read-binding SSOT; cutover clears the refuse by NULLing
 * the incoming pointer.
 */
export function assertVectorReadsAllowed(
  state: EmbeddingGenerationState | null | undefined
): void {
  if (
    state != null &&
    state.incomingSlot !== null &&
    state.rotateMode === "downtime"
  ) {
    throw new GraphragError(
      "embedding rotate downtime: vector retrieve refused until cutover",
      "STORAGE_ERROR"
    );
    // EXIT: downtime path — the only way out is cutover (or aborting via drop).
  }
}

function assertReadableGenerationRow(
  row: GenerationRow
): asserts row is GenerationRow & { rotate_mode: EmbedRotateMode | null } {
  if (row.rotate_mode !== null && !isEmbedRotateMode(row.rotate_mode)) {
    throw new GraphragError(
      `embedding_generation: persisted rotate_mode "${row.rotate_mode}" is outside the vocabulary`,
      "STORAGE_ERROR"
    );
    // EXIT: a row the CHECK constraint should not allow means the ledger
    // was written outside this module; refuse to interpret it.
  }
  if (row.incoming_slot !== null && row.incoming_dimensions === null) {
    throw new GraphragError(
      "embedding_generation: incoming slot without incoming dimensions is corrupt",
      "STORAGE_ERROR"
    );
    // EXIT: same doctrine — never guess half a generation.
  }
  const rollbackSlot = row.rollback_slot ?? null;
  if (rollbackSlot !== null && (row.rollback_dimensions ?? null) === null) {
    throw new GraphragError(
      "embedding_generation: rollback slot without rollback dimensions is corrupt",
      "STORAGE_ERROR"
    );
    // EXIT: half a displaced generation cannot be rolled back or dropped safely.
  }
}

/** The typed read of the singleton; null = no row yet (fresh or pre-ledger store). */
export async function readGenerationState(
  client: SchemaBootstrapClient
): Promise<EmbeddingGenerationState | null> {
  const result = await client.query(
    "SELECT active_slot, active_model, active_dimensions, incoming_slot, incoming_model, incoming_dimensions, rotate_mode, rollback_slot, rollback_model, rollback_dimensions, embed_host_hash, updated_at FROM embedding_generation WHERE id = 1"
  );
  const row = result.rows[0] as GenerationRow | undefined;
  if (row === undefined) return null;
  assertReadableGenerationRow(row);
  const rollbackSlot = row.rollback_slot ?? null;
  return {
    activeSlot: row.active_slot,
    active: {
      model: row.active_model,
      dimensions: row.active_dimensions,
    },
    incomingSlot: row.incoming_slot,
    incoming:
      row.incoming_slot === null
        ? null
        : {
            model: row.incoming_model,
            dimensions: row.incoming_dimensions as number,
          },
    rotateMode: row.incoming_slot === null ? null : row.rotate_mode,
    rollbackSlot,
    rollback:
      rollbackSlot === null
        ? null
        : {
            model: row.rollback_model ?? null,
            dimensions: row.rollback_dimensions as number,
          },
    embedHostHash: row.embed_host_hash ?? null,
    updatedAt: row.updated_at,
  };
}

/** The physical `vector(N)` width of one slot on one table; undefined = absent. */
async function readSlotWidth(
  client: SchemaBootstrapClient,
  table: RotationTable,
  slot: string
): Promise<number | undefined> {
  assertSafeSlot(slot);
  const result = await client.query(
    `SELECT format_type(atttypid, atttypmod) AS column_type
       FROM pg_attribute
       JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_class.relname = $1
        AND pg_attribute.attname = '${slot}'
        AND NOT pg_attribute.attisdropped
        AND pg_namespace.nspname = current_schema()`,
    [table]
  );
  const raw = (result.rows[0] as { column_type?: unknown } | undefined)
    ?.column_type;
  if (typeof raw !== "string") return undefined;
  const match = /^vector\((\d+)\)$/.exec(raw);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Boot seed / backfill / refuse guard (spec assumptions 5 + 9).
 *
 * 1. Fresh or pre-ledger store: seed the singleton from the PHYSICAL
 *    chunks.embedding width (the only generational fact an old store kept)
 *    plus the configured model.
 * 2. desired == active: boot.
 * 3. desired == an OPEN rotate's incoming: boot (reads stay on active until
 *    cutover; writes dual-write — T2/T3).
 * 4. Otherwise: typed ConfigError naming BOTH pairs. Never a DROP of the
 *    live column — the retired drop-and-add align must not return.
 */
function embedHostHashOf(embedBaseUrl: string | undefined): string | null {
  if (embedBaseUrl === undefined || embedBaseUrl.trim() === "") return null;
  try {
    return hostnameHash(embedBaseUrl);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw new ConfigError("embedBaseUrl is unparseable");
  }
}

async function applyEmbedHostGuard(
  client: SchemaBootstrapClient,
  state: EmbeddingGenerationState,
  desired: DesiredEmbeddingGeneration
): Promise<EmbeddingGenerationState> {
  const desiredHash = embedHostHashOf(desired.embedBaseUrl);
  if (desiredHash === null) return state;
  const stored = state.embedHostHash;
  if (stored === null) {
    await client.query(
      `UPDATE embedding_generation
          SET embed_host_hash = $1
        WHERE id = 1 AND embed_host_hash IS NULL`,
      [desiredHash]
    );
    return { ...state, embedHostHash: desiredHash };
  }
  if (stored !== desiredHash && state.incomingSlot === null) {
    throw new ConfigError(
      "embedding host mismatch: effective embed host differs from the generation singleton and no rotate is open"
    );
  }
  return state;
}

export async function guardEmbeddingBoot(
  client: SchemaBootstrapClient,
  desired: DesiredEmbeddingGeneration
): Promise<EmbeddingGenerationState> {
  let state = await readGenerationState(client);
  if (state === null) {
    const catalogWidth = await readSlotWidth(
      client,
      "chunks",
      EMBEDDING_SLOT_BASE
    );
    if (catalogWidth === undefined) {
      throw new GraphragError(
        "embedding-generation boot guard: chunks.embedding is absent — schema bootstrap did not complete",
        "STORAGE_ERROR"
      );
      // EXIT: without the legacy slot there is no generation to record.
    }
    // ON CONFLICT DO NOTHING keeps two concurrent boots idempotent: the
    // loser reads back the winner's row and re-runs the same comparison.
    await client.query(
      `INSERT INTO embedding_generation
         (id, active_slot, active_model, active_dimensions, embed_host_hash, updated_at)
       VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO NOTHING`,
      [
        EMBEDDING_SLOT_BASE,
        desired.model ?? null,
        catalogWidth,
        embedHostHashOf(desired.embedBaseUrl),
      ]
    );
    state = await readGenerationState(client);
    if (state === null) {
      throw new GraphragError(
        "embedding-generation boot guard: singleton row missing after seed",
        "STORAGE_ERROR"
      );
      // EXIT: INSERT+SELECT in one backend boot cannot both succeed and
      // find nothing short of an external DELETE.
    }
  }
  const desiredPair = toPair(desired);
  if (sameGenerationPair(desiredPair, state.active)) {
    return applyEmbedHostGuard(client, state, desired);
  }
  if (
    state.incoming !== null &&
    sameGenerationPair(desiredPair, state.incoming)
  ) {
    return applyEmbedHostGuard(client, state, desired);
  }
  throw new ConfigError(
    `embedding generation mismatch: desired ${pairLabel(desiredPair)} but ` +
      `active ${pairLabel(state.active)} and no open rotate whose incoming ` +
      `matches desired — run the embedding rotate CLI to open a rotate first; ` +
      `the live vector column is left intact (no drop)`
  );
  // EXIT: boot refuse (spec SC "Boot with desired ≠ active and no rotate
  // row: typed ConfigError; catalog still has the old vector column").
}

/** Per-table slot DDL stays here, small and named, so no god-function
 * inlines SQL for three tables (complexity-anti-drift ACR). */
async function addSlotColumn(
  client: SchemaBootstrapClient,
  table: RotationTable,
  slot: string,
  dimensions: number
): Promise<void> {
  assertSafeSlot(slot);
  // The new slot starts NULL-only: fill is the rotate job (T2/T4), never a
  // CAST of old floats.
  await client.query(
    `ALTER TABLE ${table} ADD COLUMN ${slot} vector(${dimensions})`
  );
}

async function createSlotIndex(
  client: SchemaBootstrapClient,
  table: RotationTable,
  slot: string
): Promise<void> {
  assertSafeSlot(slot);
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${slotIndexName(table, slot)}
       ON ${table} USING hnsw (${slot} vector_cosine_ops)`
  );
}

/**
 * Deterministic next physical slot: `embedding_g2`, `embedding_g3`, …
 * skipping any name already live on one of the rotation tables (a dropped
 * predecessor may have taken a number with it — names never recycle while
 * a same-named column exists, and cutover/drop are T4's explicit steps).
 */
async function nextFreeSlot(client: SchemaBootstrapClient): Promise<string> {
  const result = await client.query(
    `SELECT DISTINCT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1)
        AND column_name LIKE 'embedding%'`,
    [[...ROTATION_TABLES]]
  );
  const used = new Set(
    (result.rows as { column_name: string }[]).map((row) => row.column_name)
  );
  for (let i = 2; i <= 1000; i += 1) {
    const candidate = `embedding_g${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new GraphragError(
    "embedding-generation: no free incoming slot name within the g-counter budget",
    "STORAGE_ERROR"
  );
  // EXIT: 999 never-recycled slots is operator-proof in practice; refusing
  // beats minting an identifier outside the validated shape.
}

/**
 * Open a rotate: add the incoming slot column + its own cosine HNSW index on
 * all three classes (entities included — its legacy column never had one)
 * and record `incoming_*` on the singleton.
 *
 * Refusals are typed and pre-DDL: bad mode, desired == active ("nothing to
 * rotate"), an already-open rotate ("concurrent second rotate is a typed
 * refuse"), and a width over the ANN limit. No cutover/drop/rollback here —
 * that is T4; no writes here — dual-write is T2.
 */
export async function openRotate(
  client: SchemaBootstrapClient,
  desired: DesiredEmbeddingGeneration,
  mode: EmbedRotateMode,
  annMaxDimensions: number = readPgvectorAnnMaxDimensions()
): Promise<EmbeddingGenerationState> {
  if (!isEmbedRotateMode(mode)) {
    throw new GraphragError(
      "openRotate: rotate mode must be one of dual_write | downtime",
      "INVALID_INPUT"
    );
    // EXIT: runtime boundary for non-TS callers (CLI passes user input).
  }
  const state = await readGenerationState(client);
  if (state === null) {
    throw new GraphragError(
      "openRotate: no embedding_generation singleton — boot the backend once first",
      "STORAGE_ERROR"
    );
    // EXIT: rotate needs a generation to rotate away from.
  }
  assertPgvectorAnnDimensions(desired.dimensions, annMaxDimensions);
  const desiredPair = toPair(desired);
  if (sameGenerationPair(desiredPair, state.active)) {
    throw new GraphragError(
      `openRotate: desired ${pairLabel(desiredPair)} equals the active generation — nothing to rotate`,
      "INVALID_INPUT"
    );
    // EXIT: empty rotate.
  }
  if (state.incomingSlot !== null && state.incoming !== null) {
    throw new GraphragError(
      `openRotate: a rotate is already open (incoming slot ${state.incomingSlot} at ` +
        `${pairLabel(state.incoming)}); a concurrent second rotate is refused`,
      "INVALID_INPUT"
    );
    // EXIT: one incoming slot at a time — cutover/drop (T4) closes it.
  }
  // Review repair F: `cutoverRotate` refuses while a rollback generation
  // awaits its drop; opening here would let a re-open + drop destroy the
  // in-flight incoming along with the pending rollback. Same refusal, one
  // place, BEFORE any DDL.
  if (state.rollbackSlot !== null) {
    throw new GraphragError(
      `openRotate: the previous generation's slot ${state.rollbackSlot} ` +
        `still awaits its drop — run drop first`,
      "INVALID_INPUT"
    );
    // EXIT: drop the pending rollback generation before opening a new
    // rotate; the ledger must carry at most one inactive pointer pair.
  }
  const slot = await nextFreeSlot(client);
  await client.query("BEGIN");
  try {
    for (const table of ROTATION_TABLES) {
      await addSlotColumn(client, table, slot, desired.dimensions);
      await createSlotIndex(client, table, slot);
    }
    await client.query(
      `UPDATE embedding_generation
          SET incoming_slot = $1,
              incoming_model = $2,
              incoming_dimensions = $3,
              rotate_mode = $4,
              updated_at = now()
        WHERE id = 1`,
      [slot, desired.model ?? null, desired.dimensions, mode]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof GraphragError || err instanceof ConfigError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new GraphragError(
      `openRotate failed: ${message} (rolled back; active generation intact)`,
      "STORAGE_ERROR"
    );
  }
  const opened = await readGenerationState(client);
  if (opened === null) {
    throw new GraphragError(
      "openRotate: singleton row vanished after commit",
      "STORAGE_ERROR"
    );
    // EXIT: committed UPDATE can only be undone externally.
  }
  return opened;
}
