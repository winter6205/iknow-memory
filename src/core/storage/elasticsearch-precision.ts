/**
 * Elasticsearch precision layer.
 *
 * Postgres remains authoritative for chunks, entities, aliases, and their
 * validity. This module owns only the derived lexical indexes and the
 * analysis/query shape used to read them. The same IK analyzers are installed
 * on every derived index: `ik_max_word` at index time and `ik_smart` at query
 * time.
 *
 * The client is injected as a small structural port so unit tests can prove
 * request bodies without a running cluster. Production construction happens
 * only when the operator configured an Elasticsearch node.
 */
import { Client } from "@elastic/elasticsearch";

import type { ElasticsearchConfig, GraphragEnv } from "../../config.js";
import { redactDiagnostic } from "../../logging.js";
import { GraphragError, type GraphragFailureToken } from "../errors.js";
import { COMMUNITY_SUMMARY_INDEX_FAILURE } from "../types.js";
import type {
  ChunkRecord,
  PrecisionSearchOptions,
  RetrievedChunk,
  SearchOptions,
} from "../types.js";
import type {
  CommunityReportLexicalStorage,
  CommunitySummaryRow,
  EntityLexicalStorage,
} from "../retrieval/types.js";
import type { EntityType } from "../extraction/entity-type.js";

/** Minimal ES API used by this bounded context. */
export interface ElasticsearchClientLike {
  indices: {
    exists(request: Record<string, unknown>): Promise<unknown>;
    create(request: Record<string, unknown>): Promise<unknown>;
    analyze(request: Record<string, unknown>): Promise<unknown>;
    delete(request: Record<string, unknown>): Promise<unknown>;
    getAlias(request: Record<string, unknown>): Promise<unknown>;
    updateAliases(request: Record<string, unknown>): Promise<unknown>;
  };
  bulk(request: Record<string, unknown>): Promise<unknown>;
  search(request: Record<string, unknown>): Promise<unknown>;
  updateByQuery?(request: Record<string, unknown>): Promise<unknown>;
  deleteByQuery?(request: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface EntityIndexRecord {
  id: string;
  canonical_name: string;
  aliases: string[];
  type: string;
  retired?: boolean;
  merged_into?: string | null;
}

/** The derived indexes this module owns; one kind per index. */
export type PrecisionIndexKind = "chunk" | "entity" | "summary";

/**
 * One community report projected into the derived summary index.
 *
 * `community_id` is the document identity WITHIN one generation. The write
 * path publishes a generation as a whole (see `indexCommunitySummaries`), so
 * a community absent from the new generation has no document left behind.
 * `id` is the ledger row's own id, so a report ranked by both this index and
 * the ledger's vector arm fuses as ONE hit (cross-arm identity is the hit id).
 * `level` is the product grain the read side caps on.
 */
export interface CommunitySummaryIndexRecord {
  id: string;
  community_id: string;
  content: string;
  level: number;
}

/** Write + lookup port used by ingestion, extraction, and retrieve wiring. */
export interface PrecisionIndexer extends EntityLexicalStorage {
  searchLexical(query: string, opts: SearchOptions): Promise<RetrievedChunk[]>;
  indexChunks(chunks: readonly ChunkRecord[]): Promise<void>;
  indexEntities(entities: readonly EntityIndexRecord[]): Promise<void>;
  /**
   * Publish a NON-EMPTY community-report generation as a whole: whatever is
   * readable afterwards is exactly these rows, never a union with the previous
   * generation. An empty row list publishes nothing and leaves the previous
   * generation readable — clearing the index is `deleteSummaryIndex()`'s job.
   * This is the ONLY entry point that creates the summary index: a
   * read must never assume a derived index into existence, because a summary
   * index that is not there yet is a not-ready fact, not an empty answer.
   */
  indexCommunitySummaries(
    rows: readonly CommunitySummaryIndexRecord[]
  ): Promise<void>;
  rebuildChunks(chunks: readonly ChunkRecord[]): Promise<void>;
  rebuildEntities(entities: readonly EntityIndexRecord[]): Promise<void>;
  invalidateSourceRef(sourceRef: string, invalidatedAt: string): Promise<void>;
  deleteChunkIndex(): Promise<void>;
  deleteEntityIndex(): Promise<void>;
  deleteSummaryIndex(): Promise<void>;
  /**
   * Remove a set of entity ids from the entity index. Soft-merges and
   * retirements call this so the lexical entity seed layer does not keep
   * pointing at a row the ledger no longer answers for.
   */
  deleteEntities(ids: readonly string[]): Promise<void>;
  analyze(text: string, mode?: "index" | "query"): Promise<string[]>;
  close(): Promise<void>;
}

/** Typed failure for configured-but-unavailable precision-layer calls. */
export class PrecisionLayerError extends GraphragError {
  constructor(
    message: string,
    cause?: unknown,
    failureToken?: GraphragFailureToken
  ) {
    super(
      cause === undefined ? message : `${message}: ${redactDiagnostic(cause)}`,
      "STORAGE_ERROR",
      failureToken
    );
    this.name = "PrecisionLayerError";
  }
}

const IK_INDEX_ANALYZER = "ik_index";
const IK_QUERY_ANALYZER = "ik_query";
const BM25_SIMILARITY = "iknow_bm25";
const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const DEFAULT_CHUNK_FIELDS: Readonly<Record<string, number>> = {
  content: 1,
  source_ref: 1,
  "metadata.*": 1,
};
const BULK_BATCH_SIZE = 1_000;

/**
 * The derived summary index is an ALIAS over two generation slots. A
 * projection fills the slot no reader currently resolves and the alias swap is
 * what publishes it, which is the only way replacement can be atomic: a
 * same-name upsert leaves retired communities' documents behind and publishes
 * whatever part of a generation was written before a failure. Two fixed slots
 * keep the index set bounded — the previous generation is reclaimed by the
 * projection after next.
 */
const SUMMARY_SLOT_SUFFIXES = ["-gen-0", "-gen-1"] as const;

function summaryGenerationSlots(alias: string): [string, string] {
  const [zero, one] = SUMMARY_SLOT_SUFFIXES;
  return [`${alias}${zero}`, `${alias}${one}`];
}

function summaryStagingSlot(
  alias: string,
  current: string | undefined
): string {
  const [first, second] = summaryGenerationSlots(alias);
  return current === first ? second : first;
}

/**
 * One atomic `_aliases` body that leaves exactly `staging` behind `alias`. A
 * pre-alias build wrote the generation to a PHYSICAL index of the alias' own
 * name; that name cannot be reused by an alias, so it is removed in the same
 * call that publishes the new generation.
 */
function summaryAliasActions(
  alias: string,
  staging: string,
  current: string | undefined
): Record<string, unknown>[] {
  const add = { add: { index: staging, alias } };
  if (current === undefined) return [add];
  if (current === alias) return [{ remove_index: { index: alias } }, add];
  return [{ remove: { index: "*", alias } }, add];
}

function summaryDocument(
  row: CommunitySummaryIndexRecord
): Record<string, unknown> {
  return {
    id: row.id,
    community_id: row.community_id,
    content: row.content,
    level: row.level,
  };
}

/** Elasticsearch answers a `getAlias` on an unknown name with a 404 error. */
function isMissingAliasResponse(error: unknown): boolean {
  const statusCode = (error as { meta?: { statusCode?: unknown } }).meta
    ?.statusCode;
  return statusCode === 404;
}

/**
 * Construct the chunk lexical request without touching Elasticsearch.
 * Exported so request semantics stay unit-testable and do not depend on
 * response fixtures.
 */
export function buildPrecisionChunkQuery(
  query: string,
  opts: SearchOptions
): Record<string, unknown> {
  const precision = opts.precision ?? {};
  const cjk = precision.cjkSegmentation ?? true;
  const fieldBoost = precision.fieldBoost ?? true;
  const fields = lexicalFields(fieldBoost, precision.fieldBoosts);
  const should: Record<string, unknown>[] = [
    {
      multi_match: {
        query,
        fields,
        type: "best_fields",
        operator: "or",
        analyzer: cjk ? IK_QUERY_ANALYZER : "standard",
        // metadata is dynamic:true, so pushed numeric fields map as long;
        // without lenient ES parses non-numeric tokens against them -> 400.
        lenient: true,
      },
    },
  ];
  if (precision.phrase ?? true) {
    should.push({
      match_phrase: {
        content: {
          query,
          boost: 2,
          analyzer: cjk ? IK_QUERY_ANALYZER : "standard",
        },
      },
    });
  }

  const filter: Record<string, unknown>[] = [
    { range: { valid_from: { lte: opts.validAt } } },
    {
      bool: {
        should: [
          { bool: { must_not: { exists: { field: "valid_until" } } } },
          { range: { valid_until: { gt: opts.validAt } } },
        ],
        minimum_should_match: 1,
      },
    },
  ];
  for (const [key, value] of Object.entries(opts.filters ?? {})) {
    filter.push({ term: { [key]: value } });
  }

  return {
    bool: {
      must: [{ bool: { should, minimum_should_match: 1 } }],
      filter,
    },
  };
}

/**
 * Community-report lexical query: the same IK best_fields multi_match shape as
 * a chunk search over the report text, narrowed by a `level` range so the
 * community-level cap is applied at recall. The range is a filter clause (not
 * a score adjustment), so an over-grain report cannot re-enter the ranking.
 */
export function buildSummaryReportQuery(
  query: string,
  maxLevel: number
): Record<string, unknown> {
  return {
    bool: {
      must: [
        {
          multi_match: {
            query,
            fields: ["content"],
            type: "best_fields",
            operator: "or",
            analyzer: IK_QUERY_ANALYZER,
          },
        },
      ],
      filter: [{ range: { level: { lte: maxLevel } } }],
    },
  };
}

function lexicalFields(
  enabled: boolean,
  overrides: Record<string, number> | undefined
): string[] {
  if (!enabled) return ["content"];
  const source = overrides ?? DEFAULT_CHUNK_FIELDS;
  return Object.entries(source)
    .filter(([, boost]) => Number.isFinite(boost) && boost > 0)
    .map(([field, boost]) => (boost === 1 ? field : `${field}^${boost}`));
}

function hasCjk(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

/** Query analyzer chosen by the CJK-segmentation switch. */
function precisionQueryAnalyzer(
  precision: PrecisionSearchOptions
): string {
  return precision.cjkSegmentation === false ? "standard" : IK_QUERY_ANALYZER;
}

/**
 * Seed-visible posture for entities: not retired, not a merge loser, and —
 * when a resolved `filters.entity_type` exists (T3) — narrowed to that one
 * closed-set type.
 */
function entitySeedFilter(
  entityType: EntityType | undefined
): Record<string, unknown>[] {
  const filter: Record<string, unknown>[] = [
    { term: { retired: false } },
    { bool: { must_not: { exists: { field: "merged_into" } } } },
  ];
  if (entityType !== undefined) {
    filter.push({ term: { type: entityType } });
  }
  return filter;
}

/** Name+alias lexical match set for entity seeds: multi_match plus optional phrase boost. */
function entityLexicalShould(
  query: string,
  precision: PrecisionSearchOptions
): Record<string, unknown>[] {
  const analyzer = precisionQueryAnalyzer(precision);
  const fields = lexicalFields(precision.fieldBoost ?? true, precision.fieldBoosts ?? {
    canonical_name: 2,
    aliases: 1.5,
  });
  const should: Record<string, unknown>[] = [
    {
      multi_match: {
        query,
        fields,
        type: "best_fields",
        operator: "or",
        analyzer,
      },
    },
  ];
  if (precision.phrase ?? true) {
    should.push({
      match_phrase: {
        canonical_name: { query, boost: 2, analyzer },
      },
    });
  }
  return should;
}

function responseBody<T>(response: unknown): T {
  if (typeof response === "object" && response !== null && "body" in response) {
    return (response as { body: T }).body;
  }
  return response as T;
}

function isIndexPresent(response: unknown): boolean {
  return responseBody<boolean>(response) === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceRecord(source: unknown): Record<string, unknown> {
  if (typeof source !== "object" || source === null) return {};
  return source as Record<string, unknown>;
}

/**
 * One Elasticsearch client and three derived indexes. `ready` memoizes index
 * creation per index and is cleared after a failed attempt so a transient
 * cluster outage can recover on the next call.
 */
export class ElasticsearchPrecisionLayer
  implements PrecisionIndexer, CommunityReportLexicalStorage
{
  private readonly client: ElasticsearchClientLike;
  private readonly k1: number;
  private readonly b: number;
  private readonly ready = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ElasticsearchConfig,
    options: {
      k1?: number;
      b?: number;
      client?: ElasticsearchClientLike;
    } = {}
  ) {
    this.k1 = validateBm25Parameter("k1", options.k1 ?? DEFAULT_K1);
    this.b = validateBm25Parameter("b", options.b ?? DEFAULT_B);
    this.client =
      options.client ??
      (new Client({
        node: config.node,
        requestTimeout: config.requestTimeoutMs,
        ...(config.apiKey !== undefined
          ? { auth: { apiKey: config.apiKey } }
          : config.username !== undefined && config.password !== undefined
            ? { auth: { username: config.username, password: config.password } }
            : {}),
      }) as unknown as ElasticsearchClientLike);
  }

  async indexChunks(chunks: readonly ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureIndex(this.config.chunkIndex, "chunk");
    const operations: unknown[] = [];
    for (const chunk of chunks) {
      operations.push({
        index: { _index: this.config.chunkIndex, _id: chunk.id },
      });
      operations.push({
        id: chunk.id,
        content: chunk.content,
        source_ref: chunk.source_ref,
        metadata: chunk.metadata,
        valid_from: chunk.valid_from,
        valid_until: chunk.valid_until,
        created_at: chunk.created_at,
      });
    }
    await this.bulk(this.config.chunkIndex, operations);
  }

  async indexEntities(entities: readonly EntityIndexRecord[]): Promise<void> {
    if (entities.length === 0) return;
    await this.ensureIndex(this.config.entityIndex, "entity");
    const operations: unknown[] = [];
    for (const entity of entities) {
      operations.push({
        index: { _index: this.config.entityIndex, _id: entity.id },
      });
      operations.push({
        id: entity.id,
        canonical_name: entity.canonical_name,
        aliases: [...new Set(entity.aliases)],
        type: entity.type,
        retired: entity.retired ?? false,
        merged_into: entity.merged_into ?? null,
      });
    }
    await this.bulk(this.config.entityIndex, operations);
  }

  /**
   * Publish one complete report generation: build it into the slot no reader
   * resolves, then swap the alias. Nothing written here is readable until the
   * swap, so a projection that fails leaves the previous generation intact
   * rather than a half-new mix.
   *
   * CONSTRAINT: the slot is chosen from an unpinned alias read, so exactly one
   * projection per summary alias may be in flight — two concurrent ones pick
   * the same slot and interleave. Single writer is a precondition of the
   * caller that owns scheduling, not something enforced here.
   */
  async indexCommunitySummaries(
    rows: readonly CommunitySummaryIndexRecord[]
  ): Promise<void> {
    if (rows.length === 0) return;
    const alias = this.config.summaryIndex;
    const current = await this.currentSummaryGeneration(alias);
    const staging = summaryStagingSlot(alias, current);
    try {
      await this.buildSummaryGeneration(staging, rows);
      await this.swapSummaryAlias(alias, staging, current);
    } catch (failure) {
      await this.discardSummarySlot(staging, failure);
    }
  }

  /**
   * The generation readers resolve today: the alias' concrete index, the alias
   * NAME itself when a pre-alias build left a physical index of that name, or
   * undefined before the first successful projection.
   */
  private async currentSummaryGeneration(
    alias: string
  ): Promise<string | undefined> {
    if (!(await this.summaryIndexPresent())) return undefined;
    return (await this.summaryAliasTarget(alias)) ?? alias;
  }

  private async summaryAliasTarget(
    alias: string
  ): Promise<string | undefined> {
    try {
      const response = await this.client.indices.getAlias({ name: alias });
      return Object.keys(responseBody<Record<string, unknown>>(response))[0];
    } catch (error) {
      if (isMissingAliasResponse(error)) return undefined;
      throw new PrecisionLayerError(
        `Elasticsearch summary alias "${alias}" lookup failed`,
        errorMessage(error)
      );
    }
  }

  private async buildSummaryGeneration(
    slot: string,
    rows: readonly CommunitySummaryIndexRecord[]
  ): Promise<void> {
    await this.deleteIndex(slot);
    await this.ensureIndex(slot, "summary");
    const operations: unknown[] = [];
    for (const row of rows) {
      operations.push({ index: { _index: slot, _id: row.community_id } });
      operations.push(summaryDocument(row));
    }
    await this.bulk(slot, operations);
  }

  private async swapSummaryAlias(
    alias: string,
    staging: string,
    current: string | undefined
  ): Promise<void> {
    try {
      await this.client.indices.updateAliases({
        actions: summaryAliasActions(alias, staging, current),
      });
    } catch (error) {
      throw new PrecisionLayerError(
        `Elasticsearch summary alias "${alias}" could not be repointed`,
        errorMessage(error)
      );
    }
  }

  private async discardSummarySlot(
    slot: string,
    failure: unknown
  ): Promise<never> {
    // EXIT: the slot was never published, so a failed discard is hygiene, not
    // a reader-visible state — it must not replace the projection's failure.
    await this.deleteIndex(slot).catch(() => undefined);
    throw failure;
  }

  async rebuildChunks(chunks: readonly ChunkRecord[]): Promise<void> {
    await this.deleteChunkIndex();
    await this.indexChunks(chunks);
  }

  async rebuildEntities(entities: readonly EntityIndexRecord[]): Promise<void> {
    await this.deleteEntityIndex();
    await this.indexEntities(entities);
  }

  async invalidateSourceRef(
    sourceRef: string,
    invalidatedAt: string
  ): Promise<void> {
    await this.ensureIndex(this.config.chunkIndex, "chunk");
    if (this.client.updateByQuery === undefined) {
      throw new PrecisionLayerError(
        "Elasticsearch client does not support source invalidation"
      );
    }
    try {
      await this.client.updateByQuery({
        index: this.config.chunkIndex,
        refresh: true,
        query: { term: { source_ref: sourceRef } },
        script: {
          lang: "painless",
          source:
            "if (ctx._source.valid_until == null || " +
            "ctx._source.valid_until > params.invalidated_at) " +
            "{ ctx._source.valid_until = params.invalidated_at; }",
          params: { invalidated_at: invalidatedAt },
        },
      });
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch source invalidation failed",
        errorMessage(error)
      );
    }
  }

  async deleteChunkIndex(): Promise<void> {
    await this.deleteIndex(this.config.chunkIndex);
  }

  async deleteEntityIndex(): Promise<void> {
    await this.deleteIndex(this.config.entityIndex);
  }

  /**
   * Remove every physical generation of the derived summary index. Deleting
   * the slots is what retires the alias (Elasticsearch drops alias entries
   * with their index); the trailing name check clears a pre-alias build's
   * index, which carries the alias name itself.
   */
  async deleteSummaryIndex(): Promise<void> {
    const alias = this.config.summaryIndex;
    for (const slot of summaryGenerationSlots(alias)) {
      await this.deleteIndex(slot);
    }
    await this.deleteIndex(alias);
  }

  async deleteEntities(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureIndex(this.config.entityIndex, "entity");
    if (this.client.deleteByQuery === undefined) {
      throw new PrecisionLayerError(
        "Elasticsearch client does not support entity deletion"
      );
    }
    try {
      await this.client.deleteByQuery({
        index: this.config.entityIndex,
        refresh: true,
        conflicts: "proceed",
        query: { ids: { values: [...ids] } },
      });
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch entity deletion failed",
        errorMessage(error)
      );
    }
  }

  async analyze(
    text: string,
    mode: "index" | "query" = "query"
  ): Promise<string[]> {
    const index = this.config.chunkIndex;
    await this.ensureIndex(index, "chunk");
    try {
      const response = await this.client.indices.analyze({
        index,
        analyzer: mode === "index" ? IK_INDEX_ANALYZER : IK_QUERY_ANALYZER,
        text,
      });
      const body = responseBody<{ tokens?: Array<{ token?: unknown }> }>(
        response
      );
      return (body.tokens ?? [])
        .map((token) => token.token)
        .filter((token): token is string => typeof token === "string");
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch analyze failed",
        errorMessage(error)
      );
    }
  }

  /**
   * Chunk lexical search. k1/b are INDEX-TIME parameters on this backend:
   * they land in the BM25 similarity settings when `createIndexIfMissing`
   * builds the index, and Elasticsearch does not accept per-request BM25
   * overrides — a k1/b passed through `opts.precision` is deliberately NOT
   * consumed here (no fake query-time channel). The query-time k1/b
   * consumer is the MemoryBackend test double only, which computes BM25
   * in-process and can apply them per query. Same knob, different
   * mechanism; see docs/runbooks/es-precision-layer.md for the operator
   * procedure to change k1/b (rebuild the index).
   */
  async searchLexical(
    query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    if (opts.limit <= 0 || query.trim() === "") return [];
    const precision = opts.precision ?? {};
    if (precision.cjkSegmentation === false && hasCjk(query)) return [];
    await this.ensureIndex(this.config.chunkIndex, "chunk");
    try {
      const response = await this.client.search({
        index: this.config.chunkIndex,
        size: opts.limit,
        track_total_hits: false,
        query: buildPrecisionChunkQuery(query, opts),
        _source: ["id", "content", "source_ref", "valid_from", "valid_until"],
      });
      const body = responseBody<SearchResponse>(response);
      return body.hits.hits
        .map((hit) => toRetrievedChunk(hit))
        .filter((hit): hit is RetrievedChunk => hit !== undefined);
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch chunk search failed",
        errorMessage(error)
      );
    }
  }

  /**
   * Lexical entity seed search. `entityType` (resolved
   * `filters.entity_type`, specs/entity-type-and-filter.md) adds a term
   * filter on the projected entity `type` so the lexical half of the graph
   * arm's seed fusion cannot smuggle other types into a restricted seed set.
   */
  async searchEntities(
    query: string,
    limit: number,
    precision: PrecisionSearchOptions = {},
    entityType?: EntityType
  ): Promise<EntitySeedHit[]> {
    if (limit <= 0 || query.trim() === "") return [];
    if (precision.cjkSegmentation === false && hasCjk(query)) return [];
    await this.ensureIndex(this.config.entityIndex, "entity");
    const entityFilter = entitySeedFilter(entityType);
    const should = entityLexicalShould(query, precision);
    try {
      const response = await this.client.search({
        index: this.config.entityIndex,
        size: limit,
        track_total_hits: false,
        query: {
          bool: {
            must: [{ bool: { should, minimum_should_match: 1 } }],
            filter: entityFilter,
          },
        },
        _source: ["id", "canonical_name"],
      });
      const body = responseBody<SearchResponse>(response);
      return body.hits.hits
        .map((hit) => toEntitySeedHit(hit))
        .filter((hit): hit is EntitySeedHit => hit !== undefined);
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch entity search failed",
        errorMessage(error)
      );
    }
  }

  /**
   * Lexical search over community REPORT text — the ES half of 档 C's two
   * parallel arms (specs/search-mode-graph-global.md assumption 6). It mirrors
   * `searchLexical`'s IK multi_match shape, but caps the grain IN THE QUERY
   * (`level <= maxLevel`) so an over-grain report is never recalled even when
   * it would score highest (specs/community-level.md).
   *
   * Fail-closed on readiness, and only that failure is typed: the read checks
   * presence with `indices.exists` and NEVER `ensureIndex` — a derived index
   * the read assumes into existence would turn "not built yet" into a silently
   * empty answer. An absent index is a not-ready fact, surfaced as the
   * `community_summary_index_failure` token so it routes to the 档 C refusal
   * rather than a healthy `{ rows: [] }`. A present index whose query then
   * errors is a transient arm failure (no token), which the caller may still
   * fuse around with its partner arm.
   */
  async searchCommunitySummariesLexical(
    query: string,
    limit: number,
    maxLevel: number
  ): Promise<CommunitySummaryRow[]> {
    if (limit <= 0 || query.trim() === "") return [];
    if (!(await this.summaryIndexPresent())) {
      throw new PrecisionLayerError(
        `Elasticsearch summary index "${this.config.summaryIndex}" is not ready: ` +
          `${COMMUNITY_SUMMARY_INDEX_FAILURE}`,
        undefined,
        COMMUNITY_SUMMARY_INDEX_FAILURE
      );
    }
    try {
      const response = await this.client.search({
        index: this.config.summaryIndex,
        size: limit,
        track_total_hits: false,
        query: buildSummaryReportQuery(query, maxLevel),
        _source: ["id", "community_id", "content", "level"],
      });
      const body = responseBody<SearchResponse>(response);
      return body.hits.hits
        .map((hit) => toCommunitySummaryRow(hit))
        .filter((row): row is CommunitySummaryRow => row !== undefined);
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch community report search failed",
        errorMessage(error)
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Presence-only check on the summary index. Deliberately does not consult
   * or populate the `ready` memoization map — that map is the WRITE path's
   * buffer for index creation, and a read must stay free of shared mutable
   * state so concurrent reads cannot race a creation it never wanted.
   */
  private async summaryIndexPresent(): Promise<boolean> {
    try {
      const exists = await this.client.indices.exists({
        index: this.config.summaryIndex,
      });
      return isIndexPresent(exists);
    } catch (error) {
      // A cluster that cannot answer the existence probe is an erroring
      // dependency, not a not-ready fact: no token, so the caller treats it
      // as a transient arm failure rather than the typed refusal.
      throw new PrecisionLayerError(
        "Elasticsearch summary index availability check failed",
        errorMessage(error)
      );
    }
  }

  private async ensureIndex(
    index: string,
    kind: PrecisionIndexKind
  ): Promise<void> {
    const existing = this.ready.get(index);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const attempt = this.createIndexIfMissing(index, kind);
    this.ready.set(index, attempt);
    try {
      await attempt;
    } catch (error) {
      this.ready.delete(index);
      throw error;
    }
  }

  private async createIndexIfMissing(
    index: string,
    kind: PrecisionIndexKind
  ): Promise<void> {
    try {
      const exists = await this.client.indices.exists({ index });
      if (isIndexPresent(exists)) return;
      await this.client.indices.create({
        index,
        settings: precisionSettings(this.k1, this.b),
        mappings: indexMappings(kind),
      });
    } catch (error) {
      throw new PrecisionLayerError(
        `Elasticsearch ${kind} index "${index}" is unavailable`,
        errorMessage(error)
      );
    }
  }

  private async deleteIndex(index: string): Promise<void> {
    this.ready.delete(index);
    try {
      const exists = await this.client.indices.exists({ index });
      if (!isIndexPresent(exists)) return;
      await this.client.indices.delete({ index });
    } catch (error) {
      throw new PrecisionLayerError(
        `Elasticsearch index "${index}" could not be deleted`,
        errorMessage(error)
      );
    }
  }

  private async bulk(index: string, operations: unknown[]): Promise<void> {
    for (
      let offset = 0;
      offset < operations.length;
      offset += BULK_BATCH_SIZE * 2
    ) {
      const batch = operations.slice(offset, offset + BULK_BATCH_SIZE * 2);
      try {
        const response = await this.client.bulk({
          index,
          refresh: "wait_for",
          operations: batch,
        });
        const body = responseBody<BulkResponse>(response);
        if (body.errors === true) {
          throw new Error("one or more bulk operations failed");
        }
      } catch (error) {
        throw new PrecisionLayerError(
          `Elasticsearch bulk index "${index}" failed`,
          errorMessage(error)
        );
      }
    }
  }
}

interface SearchHit {
  _id?: string;
  _score?: number | null;
  _source?: unknown;
}

interface SearchResponse {
  hits: { hits: SearchHit[] };
}

interface BulkResponse {
  errors?: boolean;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Entity-seed row shape shared by `searchEntities` and its hit mapper. */
type EntitySeedHit = { id: string; canonical_name: string; score?: number };

function toEntitySeedHit(hit: SearchHit): EntitySeedHit | undefined {
  const source = sourceRecord(hit._source);
  const id = stringValue(source.id) ?? hit._id;
  const canonicalName = stringValue(source.canonical_name);
  if (id === undefined || canonicalName === undefined) return undefined;
  return {
    id,
    canonical_name: canonicalName,
    ...(typeof hit._score === "number" ? { score: hit._score } : {}),
  };
}

/** Project one report hit into a `CommunitySummaryRow` (id keeps ledger identity). */
function toCommunitySummaryRow(hit: SearchHit): CommunitySummaryRow | undefined {
  const source = sourceRecord(hit._source);
  const id = stringValue(source.id) ?? hit._id;
  const communityId = stringValue(source.community_id);
  const summary = stringValue(source.content);
  if (
    id === undefined ||
    communityId === undefined ||
    summary === undefined ||
    typeof source.level !== "number"
  ) {
    return undefined;
  }
  return {
    id,
    communityId,
    summary,
    level: source.level,
    ...(typeof hit._score === "number" ? { score: hit._score } : {}),
  };
}

function toRetrievedChunk(hit: SearchHit): RetrievedChunk | undefined {
  const source = sourceRecord(hit._source);
  const id = stringValue(source.id) ?? stringValue(hit._id);
  const content = stringValue(source.content);
  const sourceRef = stringValue(source.source_ref);
  const validFrom = stringValue(source.valid_from);
  if (
    id === undefined ||
    content === undefined ||
    sourceRef === undefined ||
    validFrom === undefined
  ) {
    return undefined;
  }
  const validUntil =
    source.valid_until === null
      ? null
      : (stringValue(source.valid_until) ?? null);
  return {
    id,
    content,
    source_ref: sourceRef,
    valid_window: [validFrom, validUntil],
    score: typeof hit._score === "number" ? hit._score : 0,
  };
}

function validateBm25Parameter(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PrecisionLayerError(
      `Elasticsearch BM25 ${name} must be a finite positive number`
    );
  }
  return value;
}

function precisionSettings(k1: number, b: number): Record<string, unknown> {
  return {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        [IK_INDEX_ANALYZER]: {
          type: "custom",
          tokenizer: "ik_max_word",
        },
        [IK_QUERY_ANALYZER]: {
          type: "custom",
          tokenizer: "ik_smart",
        },
      },
    },
    similarity: {
      [BM25_SIMILARITY]: {
        type: "BM25",
        k1,
        b,
      },
    },
  };
}

function chunkMappings(): Record<string, unknown> {
  return {
    properties: {
      id: { type: "keyword" },
      content: {
        type: "text",
        analyzer: IK_INDEX_ANALYZER,
        search_analyzer: IK_QUERY_ANALYZER,
        similarity: BM25_SIMILARITY,
      },
      source_ref: { type: "keyword" },
      metadata: { type: "object", dynamic: true },
      valid_from: { type: "date" },
      valid_until: { type: "date" },
      created_at: { type: "date" },
    },
  };
}

function entityMappings(): Record<string, unknown> {
  return {
    properties: {
      id: { type: "keyword" },
      canonical_name: {
        type: "text",
        analyzer: IK_INDEX_ANALYZER,
        search_analyzer: IK_QUERY_ANALYZER,
        similarity: BM25_SIMILARITY,
        fields: { keyword: { type: "keyword" } },
      },
      aliases: {
        type: "text",
        analyzer: IK_INDEX_ANALYZER,
        search_analyzer: IK_QUERY_ANALYZER,
        similarity: BM25_SIMILARITY,
      },
      type: { type: "keyword" },
      retired: { type: "boolean" },
      merged_into: { type: "keyword" },
    },
  };
}

/** The one mapping per derived index kind. */
function indexMappings(kind: PrecisionIndexKind): Record<string, unknown> {
  if (kind === "chunk") return chunkMappings();
  if (kind === "entity") return entityMappings();
  return summaryMappings();
}

function summaryMappings(): Record<string, unknown> {
  return {
    properties: {
      id: { type: "keyword" },
      community_id: { type: "keyword" },
      content: {
        type: "text",
        analyzer: IK_INDEX_ANALYZER,
        search_analyzer: IK_QUERY_ANALYZER,
        similarity: BM25_SIMILARITY,
      },
      // Queryable, not just stored: a reader applying the community-level cap
      // must be able to bound `level <= N` in the query itself, so an
      // over-grain report is filtered at recall rather than after ranking.
      level: { type: "integer" },
    },
  };
}

/**
 * The precision layer for an operator-configured deployment, or undefined when
 * none is configured — the caller then runs Postgres-only and skips its write
 * leg. Every entry point that wires the layer from a resolved `GraphragEnv`
 * block goes through here, so the env→layer mapping (endpoint + BM25 knobs) has
 * exactly one owner.
 */
export function createPrecisionLayer(
  env: GraphragEnv
): ElasticsearchPrecisionLayer | undefined {
  if (env.elasticsearch === undefined) return undefined;
  return new ElasticsearchPrecisionLayer(env.elasticsearch, {
    k1: env.retrieval.k1,
    b: env.retrieval.b,
  });
}
