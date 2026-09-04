/**
 * Elasticsearch precision layer.
 *
 * Postgres remains authoritative for chunks, entities, aliases, and their
 * validity. This module owns only the derived lexical indexes and the
 * analysis/query shape used to read them. The same IK analyzers are installed
 * on both indexes: `ik_max_word` at index time and `ik_smart` at query time.
 *
 * The client is injected as a small structural port so unit tests can prove
 * request bodies without a running cluster. Production construction happens
 * only when the operator configured an Elasticsearch node.
 */
import { Client } from "@elastic/elasticsearch";

import type { ElasticsearchConfig } from "../../config.js";
import { redactDiagnostic } from "../../logging.js";
import { GraphragError } from "../errors.js";
import type {
  ChunkRecord,
  PrecisionSearchOptions,
  RetrievedChunk,
  SearchOptions,
} from "../types.js";
import type { EntityLexicalStorage } from "../retrieval/types.js";

/** Minimal ES API used by this bounded context. */
export interface ElasticsearchClientLike {
  indices: {
    exists(request: Record<string, unknown>): Promise<unknown>;
    create(request: Record<string, unknown>): Promise<unknown>;
    analyze(request: Record<string, unknown>): Promise<unknown>;
    delete(request: Record<string, unknown>): Promise<unknown>;
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

/** Write + lookup port used by ingestion, extraction, and retrieve wiring. */
export interface PrecisionIndexer extends EntityLexicalStorage {
  searchLexical(query: string, opts: SearchOptions): Promise<RetrievedChunk[]>;
  indexChunks(chunks: readonly ChunkRecord[]): Promise<void>;
  indexEntities(entities: readonly EntityIndexRecord[]): Promise<void>;
  rebuildChunks(chunks: readonly ChunkRecord[]): Promise<void>;
  rebuildEntities(entities: readonly EntityIndexRecord[]): Promise<void>;
  invalidateSourceRef(sourceRef: string, invalidatedAt: string): Promise<void>;
  deleteChunkIndex(): Promise<void>;
  deleteEntityIndex(): Promise<void>;
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
  constructor(message: string, cause?: unknown) {
    super(
      cause === undefined ? message : `${message}: ${redactDiagnostic(cause)}`,
      "STORAGE_ERROR"
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
 * One Elasticsearch client and two derived indexes. `ready` memoizes index
 * creation per index and is cleared after a failed attempt so a transient
 * cluster outage can recover on the next call.
 */
export class ElasticsearchPrecisionLayer implements PrecisionIndexer {
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

  async searchEntities(
    query: string,
    limit: number,
    precision: PrecisionSearchOptions = {}
  ): Promise<Array<{ id: string; canonical_name: string; score?: number }>> {
    if (limit <= 0 || query.trim() === "") return [];
    if (precision.cjkSegmentation === false && hasCjk(query)) return [];
    await this.ensureIndex(this.config.entityIndex, "entity");
    const fields = lexicalFields(
      precision.fieldBoost ?? true,
      precision.fieldBoosts ?? {
        canonical_name: 2,
        aliases: 1.5,
      }
    );
    const should: Record<string, unknown>[] = [
      {
        multi_match: {
          query,
          fields,
          type: "best_fields",
          operator: "or",
          analyzer:
            precision.cjkSegmentation === false
              ? "standard"
              : IK_QUERY_ANALYZER,
        },
      },
    ];
    if (precision.phrase ?? true) {
      should.push({
        match_phrase: {
          canonical_name: {
            query,
            boost: 2,
            analyzer:
              precision.cjkSegmentation === false
                ? "standard"
                : IK_QUERY_ANALYZER,
          },
        },
      });
    }
    try {
      const response = await this.client.search({
        index: this.config.entityIndex,
        size: limit,
        track_total_hits: false,
        query: {
          bool: {
            must: [{ bool: { should, minimum_should_match: 1 } }],
            filter: [
              { term: { retired: false } },
              { bool: { must_not: { exists: { field: "merged_into" } } } },
            ],
          },
        },
        _source: ["id", "canonical_name"],
      });
      const body = responseBody<SearchResponse>(response);
      return body.hits.hits.flatMap((hit) => {
        const source = sourceRecord(hit._source);
        const id = stringValue(source.id) ?? hit._id;
        const canonicalName = stringValue(source.canonical_name);
        if (id === undefined || canonicalName === undefined) return [];
        return [
          {
            id,
            canonical_name: canonicalName,
            ...(typeof hit._score === "number" ? { score: hit._score } : {}),
          },
        ];
      });
    } catch (error) {
      throw new PrecisionLayerError(
        "Elasticsearch entity search failed",
        errorMessage(error)
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async ensureIndex(
    index: string,
    kind: "chunk" | "entity"
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
    kind: "chunk" | "entity"
  ): Promise<void> {
    try {
      const exists = await this.client.indices.exists({ index });
      if (isIndexPresent(exists)) return;
      await this.client.indices.create({
        index,
        settings: precisionSettings(this.k1, this.b),
        mappings: kind === "chunk" ? chunkMappings() : entityMappings(),
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
