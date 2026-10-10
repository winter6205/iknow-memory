/**
 * iknow-memory MCP server entry.
 *
 * Wires the tool registry into a stdio MCP server. The catalog is the
 * Host-facing contract frozen by specs/mcp-tool-surface.md: ingest, push,
 * invalidate, extract, retrieve, plus the durable index-job pair
 * (`submit_index_job` / `poll_index_job`) that hands graph re-indexing to a
 * worker without changing what `push` means.
 *
 * Decoupling contract:
 *   - No import from iknow (`src/shared/schema.ts`, `src/config/`, etc.).
 *   - Provider key env-var names are looked up by NAME, never stored
 *     in code.
 *   - All logging goes to stderr; stdout is reserved for the MCP
 *     stdio JSON-RPC transport.
 *
 * SDK: `@modelcontextprotocol/server@^2.0.0` (v2 split-package line) +
 * `@modelcontextprotocol/client@^2.0.0` (for the host-smoke test harness).
 * Uses the high-level `McpServer.registerTool` API. The low-level `Server`
 * + `setRequestHandler` and the deprecated `tool(...)` method are
 * deliberately avoided.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  createEvidenceDispatcher,
  EVIDENCE_PRIVATE_METHOD,
  supportsEvidenceScopeAuthority,
} from "./core/storage/evidence-dispatch.js";

import { ConfigError, loadEnv, type GraphragEnv } from "./config.js";
import { createLogger, redactDiagnostic, writeStderr } from "./logging.js";
import { failureTokenOf } from "./core/errors.js";
import {
  StructuredQueryError,
  structuredErrorEnvelope,
} from "./core/structured/errors.js";
import { parseStdioEntry } from "./cli/stdio-entry.js";
import {
  buildRegistry,
  textResult,
  type ToolRegistration,
} from "./tools/registry.js";
import { ingestTool } from "./tools/ingest.js";
import { invalidationTool } from "./tools/invalidation.js";
import { pushTool } from "./tools/push.js";
import {
  pollIndexJobTool,
  submitIndexJobTool,
  type CommunityIndexStateReader,
  type IndexJobReadPort,
} from "./tools/index-job.js";
import { retrieveTool, type RetrieveDeps } from "./tools/retrieve.js";
import { BusinessQueryExecutor } from "./core/business-query/sql-query-executor.js";
import { BUSINESS_LEDGER_AUTHORIZED_SCOPES } from "./core/business-query/sql-query-templates.js";
import type { BusinessLedgerConfig } from "./core/business-query/sql-query-types.js";
import { readSourceTool } from "./tools/read_source.js";
import {
  PgStructuredQueryStorage,
  refuseCount,
  structuredQueryReadOutcome,
  type StructuredQueryGrantPlan,
  type StructuredQueryStorage,
} from "./core/storage/structured-query-reads.js";
import {
  queryScopeIdentityFromEnv,
  resolveQueryScope,
  QUERY_SCOPE_ENV_VARS,
  type QueryScopeIdentity,
} from "./core/storage/structured-query-scope.js";
import type { StructuredQueryReader } from "./core/structured/result.js";
import type {
  AuthorizedScopeUnitOfWork,
  ScopeTransactionOwner,
} from "./core/storage/structured-scope-types.js";
import {
  extractTool,
  type ExtractDeps,
  type ExtractPool,
} from "./tools/extract.js";
import {
  NineRouterEmbedder,
  UnavailableEmbedder,
  type EmbeddingClient,
} from "./core/embedder.js";
import {
  createSlotSourceFromGraphragEnv,
  type SlotEmbeddingSource,
} from "./core/embed-slots.js";
import { MemoryBackend } from "./core/storage/memory-backend.js";
import {
  createPrecisionLayer,
  type PrecisionIndexer,
} from "./core/storage/elasticsearch-precision.js";
import {
  createNeo4jPprRanker,
  type PprRanker,
} from "./core/graph/neo4j-ppr.js";
import { createHttpChunkReranker } from "./core/rerank/http-reranker.js";
import { createAnthropicChunkReranker } from "./core/rerank/anthropic-reranker.js";
import {
  EVIDENCE_FAILURE,
  type EvidenceStore,
  type GrantRequest,
  type IndexJobStore,
  type ScopeRevisionFence,
  type SearchOptions,
  type StorageBackend,
  type StorageReadPort,
} from "./core/types.js";
import {
  supportsCommunityIndexState,
  supportsEvidenceStore,
  supportsIndexJobStore,
  type LexicalStorageBackend,
} from "./core/storage/backend.js";

const SERVER_NAME = "iknow-memory";
const SERVER_VERSION = "0.0.0";

/**
 * Process exit codes (single source of truth — referenced by the fatal-error
 * catch in the isMain block). Anything outside this table is a bug;
 * documenting it here makes host-side scripts (Claude Code, systemd, k8s)
 * able to reason about what kind of failure happened without parsing stderr.
 *
 *   FATAL_RUNTIME    1   uncaught exception in main() — see stderr stack
 *   BAD_CONFIG       2   loadEnv() rejected the environment (ConfigError)
 *
 * BAD_CONFIG returned in T7 alongside the first real config-rejection
 * surface (unknown storage mode / pgvector without a DB URL). It had been
 * removed in stage 0 when the transport knob went away — see
 * `tests/config.test.ts`.
 */
const EXIT_CODES = {
  FATAL_RUNTIME: 1,
  BAD_CONFIG: 2,
} as const;

/** Everything the ingest/retrieve handlers need, built once per server. */
interface ServerDeps {
  embedder: EmbeddingClient;
  /**
   * Embedding generation rotate T2/T3: per-slot embedder source threaded to
   * ingest/push (dual-write) and retrieve (active-pair query embed). Built
   * only when real embedding credentials exist; absent keeps today's
   * single-generation behavior (an open rotate then typed-refuses writes).
   */
  slotEmbedding?: SlotEmbeddingSource;
  /**
   * Both production backends implement StorageReadPort on top of
   * StorageBackend (operator-console T4 — read_source reads 资料 rows
   * through the read port).
   */
  storage: StorageBackend & StorageReadPort;
  /** Optional Elasticsearch precision layer for derived indexes. */
  precision?: PrecisionIndexer;
  /**
   * Durable corpus index-job ledger, narrowed from the selected backend by
   * `supportsIndexJobStore`. Required at wiring, not per call: the job tools
   * are registered unconditionally, so a backend without the ledger would
   * otherwise turn every submit into a storage fault indistinguishable from a
   * busy queue. See `buildIndexJobSeams`.
   */
  indexJobs: IndexJobStore;
  /**
   * 档 C readiness singleton reader, narrowed by `supportsCommunityIndexState`.
   * `poll_index_job` reports it beside the job row as a separate fact — the
   * retrieve C arm is the only other reader.
   */
  communityState: CommunityIndexStateReader;
  /**
   * 资料 lookup for `submit_index_job`, adapted from the read port so a
   * missing row is `null` (the tool's own unknown-source vocabulary) rather
   * than the port's discriminated result.
   */
  indexJobReadPort: IndexJobReadPort;
  /**
   * Retrieval pipeline config. Always present — loadEnv() always returns
   * it. Structural type from GraphragEnv so this file never imports
   * src/core/retrieval/* (the isolation guard in
   * tests/cli/isolation-retrieval.test.ts enforces that).
   *
   * Reaches the retrieve tool as `retrieveConfig`, never as `graphConfig`:
   * see `buildRetrieveDeps`.
   */
  retrieval: GraphragEnv["retrieval"];
  /**
   * Neo4j PPR ranker for the production graph arm, built only when a
   * sidecar URI is configured. Undefined is passed on as an ABSENT key,
   * allowing retrieval to mark the default-on graph capability unattempted.
   * See `buildRetrieveDeps`.
   */
  graphRanker?: PprRanker;
  /** Retrieve rerank adapter: dedicated HTTP URL, else MiniMax LLM. */
  reranker?: {
    permute(
      query: string,
      candidates: readonly { id: string; content: string }[]
    ): Promise<readonly string[]>;
  };
  /**
   * Business ledger provisioning for the `sql` 档, built only when
   * `FIN_BUSINESS_LEDGER_URL` is configured. Absent is the provisioning
   * fact the arm reads as the structured `real_db_not_wired` (not
   * provisioned) exit — see specs/search-mode-business-sql-contract.md §7.
   */
  businessLedger?: BusinessLedgerConfig;
  /**
   * Query cursor signing key, read from `IKNOW_QUERY_CURSOR_KEY`. REQUIRED by
   * the structured reader and deliberately undefaulted there: a cursor states
   * where a result set continues, and an unsigned one is a value the caller
   * may choose. Absent is therefore an unprovisioned capability, which the
   * retrieve tool reports as `structured_search_unavailable` — the SPEC's
   * capability trigger — rather than minting unsigned tokens.
   */
  queryCursorKey?: string;
  /**
   * The Query identity the HOST bound to this connection, or absent when the
   * host bound none.
   *
   * This is B1's per-connection injection point, so it is an argument rather than
   * something the reader reads out of the environment: a host serving two
   * connections from one process composes two sets of deps with two bindings and
   * the two never share an identity. The production composition reads it from the
   * session's own environment through `queryScopeIdentityFromEnv`, which is the
   * channel a stdio host uses when it spawns one child per session with an
   * explicit `env=` — a channel, not a fallback, because an absent or blank
   * variable becomes an absent member and an absent member refuses. Reading it
   * ONCE, here, is what makes it per-CONNECTION: a host that spawns one child
   * per session has made this process the connection, and nothing a second
   * connection would share is read again. A host serving two connections from
   * one process instead composes two sets of deps, with two bindings, and gets
   * two identities.
   *
   * Absent is an unprovisioned capability with no reader, exactly as an absent
   * cursor key is; present but incomplete is a reader that refuses per call
   * naming the members it lacks.
   */
  queryIdentity?: QueryScopeIdentity;
}

/**
 * The one evidence capability this seam mints with: a finite, nonrenewable
 * reference whose obligations commit together with it — and, for a page, with
 * each other.
 *
 * Narrowed to the batch method because that is all a Query reader needs: a read
 * returns a whole page of grants, and issuing them one at a time would commit a
 * prefix of a page the caller may never receive. The store that provides it is
 * recognized by `supportsEvidenceStore`, which checks the whole `EvidenceStore`,
 * so a backend missing any method of that capability is not treated as partially
 * grantable.
 */
type StructuredGrantStore = Pick<EvidenceStore, "issueGrants">;

/**
 * Bind a storage-level Query reader to the tool's per-request reader.
 *
 * `identity` is the binding the HOST injected for the connection this reader
 * serves, and it is an argument rather than something read out of a process-wide
 * environment. That is B1's rule — per-connection, no process-level fallback, no
 * default scope — and it is why this function takes the identity instead of
 * reaching for one: a value read from `process.env` is one identity for every
 * connection in the process, so the guarantee would rest on the transport
 * happening to give each connection a process of its own rather than on the
 * code. A host serving two connections from one process calls this twice, with
 * two bindings, and gets two identities with nothing global mutated between them.
 *
 * The binding is therefore per CONNECTION, not per call. Re-resolving it per call
 * is not what makes two sessions differ, and nothing here claims it is: it mints
 * a fresh context each time so the reader's own entry gate stays meaningful —
 * `scopeAuthorityOf` admits the context because THIS composition minted it — while
 * the identity behind it is fixed for the connection.
 *
 * An incomplete binding refuses per call with `structured_search_unavailable`,
 * the SPEC's capability trigger and the same code an absent reader produces, so
 * a deployment whose host injected no identity reads as unprovisioned rather than
 * as an authorized empty corpus. The refusal names the members that are absent.
 * There is no fallback: all six are mandatory, and a guessed owner or an empty
 * source set would report a corpus nobody authorized.
 *
 * Exported so the seam's own properties — that two bindings produce two
 * identities, and that a row's reference is one the evidence store actually
 * minted for THAT row — are assertable against the real issuance path rather
 * than against a stand-in for it (tests/index-query-seam.test.ts,
 * tests/acceptance/structured-query-pg.test.ts).
 */
export function buildStructuredQueryReader(
  authority: AuthorizedScopeUnitOfWork & ScopeTransactionOwner,
  grants: StructuredGrantStore,
  reader: StructuredQueryStorage,
  identity: QueryScopeIdentity
): StructuredQueryReader {
  return {
    readStructuredQuery: async (request) => {
      const resolved = resolveQueryScope(authority, identity);
      if ("refusal" in resolved) {
        throw new StructuredQueryError(
          resolved.refusal,
          "structured_search_unavailable"
        );
      }
      // Next to the scope gate, not down at the issuance call: a host that
      // injected no consumer can never issue a grant, so refusing it before the
      // read keeps an unprovisioned connection from paying a full page read —
      // against the corpus — to be told at the end that nothing could be issued.
      const consumerId = requireConsumerId(identity);
      const plan = await reader.readStructuredQuery(resolved.context, request);
      const issued = await issuePage(
        grants,
        plan.grants,
        plan.issuanceFence,
        plan.scopeBinding,
        consumerId
      );
      // The storage layer owns this projection because it owns the issuer-side
      // refusal: a row or a receipt whose reference was never issued is refused
      // THERE, on the mismatch between the rows the plan returned and the
      // references the store minted. The count, by contrast, is already settled
      // one line up — `grantRequestOf` refuses an unmeasured count before any
      // grant is written, so the projection's own `count_unavailable` is the
      // backstop for a caller that reaches it another way, not the guard this
      // path depends on.
      return structuredQueryReadOutcome(plan, issued);
    },
  };
}

/**
 * Mint one reference per grant the plan carries, as a single write.
 *
 * The page is issued THROUGH the evidence store's own batch rather than a loop
 * over `issueGrant`, and that is the whole point: `issueGrant` is one reference
 * in one transaction, which is correct for one reference and strands the ones
 * already committed when a later request in the same page fails. A reference
 * pins its dependencies for 365 days, so a half-issued page leaves obligations
 * nobody can cite and nobody can unwind — and the caller, who received a refusal,
 * never learns the reference existed. The batch answers the plan's no-partial-
 * success clause at the only level it can be answered: inside the write.
 *
 * The read itself is `READ ONLY` and a grant is a WRITE, so this follows the read
 * rather than sharing its transaction. Before any grant is written, the evidence
 * store locks the scope revision row and checks the read plan's authorization and
 * purge fence. If either moved after the read, the whole batch is refused, so a
 * successful grant cannot describe a snapshot admitted by a later authorization
 * or purge revision.
 *
 * P1-I6's literal same-transaction requirement remains open: the fence check and
 * grant write share one evidence transaction, but the read snapshot was produced
 * by the preceding `READ ONLY REPEATABLE READ` transaction. Sharing one writable
 * transaction would require changing that P1-I1 guarantee.
 */
async function issuePage(
  grants: StructuredGrantStore,
  grantPlans: readonly StructuredQueryGrantPlan[],
  expectedScopeRevisionFence: ScopeRevisionFence,
  expectedScopeBinding: string,
  consumerId: string
): Promise<readonly string[]> {
  if (
    expectedScopeRevisionFence === null ||
    typeof expectedScopeRevisionFence !== "object" ||
    expectedScopeRevisionFence.scope_binding !== expectedScopeBinding
  ) {
    // EXIT: a missing or mismatched Query fence must not downgrade to the
    // optional legacy Evidence call contract.
    throw new StructuredQueryError(
      "structured query issuance fence is unavailable for its scope",
      "structured_search_unavailable"
    );
  }
  const requests = grantPlans.map((plan) => grantRequestOf(plan, consumerId));
  try {
    const issued = await grants.issueGrants(
      requests,
      expectedScopeRevisionFence
    );
    return issued.map((grant) => grant.evidence_ref);
  } catch (error) {
    // The store refuses in ITS vocabulary — `GraphragError` with a failure token
    // the evidence lane defines — so an untranslated failure would fall through
    // the adapter's structured branch and leave as the legacy `{error, message}`
    // shape, contradicting tools/retrieve.ts's promise that every structured
    // refusal is a typed envelope. A stale authorization fence is reported as
    // `authorization_denied`; stale purge state and malformed or missing fences
    // use the existing `structured_search_unavailable` refusal.
    //
    // The original message is KEPT as the error's message rather than replaced,
    // because that is the log: `structuredErrorEnvelope` builds the host payload
    // from the code alone, so the detail reaches `logger.error` and never the
    // wire, while the envelope still carries only `code` + `retryable`.
    if (error instanceof StructuredQueryError) throw error;
    // EXIT: Non-authorization issuer refusals (including stale purge and invalid or
    // unavailable fences) block artifacts and retain the typed unavailable envelope.
    throw new StructuredQueryError(
      error instanceof Error ? error.message : String(error),
      failureTokenOf(error) === EVIDENCE_FAILURE.ACCESS_DENIED
        ? "authorization_denied"
        : "structured_search_unavailable"
    );
  }
}

/**
 * The stream this connection's grants belong to, or the SPEC's own refusal.
 *
 * `consumerId` is the one grant input the HOST must supply and this seam cannot
 * derive: a plan is computed from a read that never saw a binding, so a guess
 * here would be an invented stream whose invalidations then go to a consumer
 * nobody is. It is therefore read from the same per-connection identity object
 * the six scope members come from — never from the environment, never from the
 * request — and its absence is a refusal in the same code an absent reader
 * produces, so a deployment that injected no consumer reads as unprovisioned
 * rather than as a grant published to a stream of nobody's choosing.
 *
 * Refused HERE rather than inside the store so the message names the variable,
 * and so a plan that was never issued is never partially written.
 *
 * **The two refusals of the same missing variable differ, deliberately.** This
 * seam answers `structured_search_unavailable`, the SPEC's capability trigger:
 * a connection the host bound without a consumer is not one that can read, and
 * it says so in the same code an absent reader produces. The private Evidence
 * channel reads the SAME variable through `readTrustedIdentityBinding` and
 * answers `access_denied`, because there the binding as a whole is the
 * authorization being withheld. Both refuse, neither invents a default, and an
 * operator reads the same variable name in either message. Aligning the codes
 * would mean widening `STRUCTURED_SCOPE_FAILURE_CODES` with a member the scope
 * contracts do not define, so the divergence is recorded here instead.
 */
function requireConsumerId(identity: QueryScopeIdentity): string {
  const consumerId = identity.consumerId;
  if (consumerId === undefined || consumerId.trim() === "") {
    throw new StructuredQueryError(
      "this connection was given no invalidation consumer, so its grants " +
        "could not be invalidated; inject " +
        `${QUERY_SCOPE_ENV_VARS.consumerId} alongside the Query identity`,
      "structured_search_unavailable"
    );
  }
  return consumerId.trim();
}

/**
 * One grant plan as the grant store's own request.
 *
 * The plan carries both arms on every grant — a row grant's null count and a
 * count grant's empty support set — while `normalizeGrantRequest` refuses a row
 * grant carrying a count and a count grant naming supports, because each would
 * retain something its kind may not keep. The arm this grant is NOT is
 * therefore dropped here rather than forwarded as a null.
 */
function grantRequestOf(
  plan: StructuredQueryGrantPlan,
  consumerId: string
): GrantRequest {
  const shared = {
    subject: plan.subject,
    operation: plan.operation,
    queryDigest: plan.queryDigest,
    scopeBinding: plan.scopeBinding,
    readRevision: plan.readRevision,
    queriedAt: plan.queriedAt,
    context: plan.context,
    value: plan.value,
    consumerId,
  };
  if (plan.kind === "row") {
    return { ...shared, kind: "row", supports: plan.supports };
  }
  if (plan.count === null) refuseCount();
  return { ...shared, kind: "count", count: plan.count };
}

/**
 * Read the authorized-scope seam a Query reader needs off the selected storage.
 *
 * Structural, for the same reason the evidence dispatcher's guard is: the
 * chunks-only `StorageBackend` contract is not widened to carry a structured
 * seam, so a backend that has one is recognized by its shape and a backend that
 * does not yields `undefined` — which is the unprovisioned reading, not a
 * reason to fall back to another authority.
 */
function supportsStructuredQueryScope(
  candidate: unknown
): (AuthorizedScopeUnitOfWork & ScopeTransactionOwner) | undefined {
  const seam = (
    candidate as { structuredScopeUnitOfWork?: unknown } | null | undefined
  )?.structuredScopeUnitOfWork;
  const unit = seam as Partial<AuthorizedScopeUnitOfWork> | undefined;
  const owner = seam as Partial<ScopeTransactionOwner> | undefined;
  return typeof unit?.createAuthorizedContext === "function" &&
    typeof owner?.runTransaction === "function"
    ? (seam as AuthorizedScopeUnitOfWork & ScopeTransactionOwner)
    : undefined;
}

/**
 * Assemble the retrieve tool's dependencies for the default server path.
 *
 * The loaded retrieval config travels as `retrieveConfig`, which is what
 * arms BM25 alongside the vector arm on the stock server.
 *
 * It deliberately does NOT travel as `graphConfig`: the SQL one-hop graph
 * arm is **archived off production**, and
 * `assembleRetrievalResult` gates that arm on receiving a `graphConfig`,
 * so the archive is expressed here as an absence — this function never
 * builds the key. PgvectorBackend still exposes `graphArmSeed` and
 * `graph-arm.ts` still compiles — tests that want the arm inject
 * `graphConfig` themselves — but no operator gets one-hop JOIN results
 * from the stock server. A real graph arm belongs on a native graph
 * engine; see `docs/runbooks/sql-graph-arm-archived.md`.
 *
 * The Neo4j PPR arm is wired the opposite way round: it IS the
 * production third arm, so the ranker travels whenever one was built —
 * that is, whenever the operator configured a sidecar URI. No URI means no
 * ranker, which lets `assembleRetrievalResult` report the default-on
 * capability as unattempted (`degraded: true`).
 *
 * Exported so both halves are directly assertable without a live Postgres
 * (tests/index.test.ts); reintroducing `graphConfig` here, or dropping
 * `retrieveConfig`, fails that test.
 */
export function buildRetrieveDeps(
  deps: Pick<
    ServerDeps,
    | "embedder"
    | "slotEmbedding"
    | "storage"
    | "precision"
    | "retrieval"
    | "graphRanker"
    | "reranker"
    | "businessLedger"
    | "queryCursorKey"
    | "queryIdentity"
  >,
  debug: boolean
): RetrieveDeps {
  return {
    embedder: deps.embedder,
    ...(deps.slotEmbedding !== undefined
      ? { slotEmbedding: deps.slotEmbedding }
      : {}),
    storage: deps.storage,
    ...(deps.precision !== undefined
      ? {
          lexical: lexicalAdapterFromPrecision(deps.precision),
          entityLexical: deps.precision,
        }
      : {}),
    retrieveConfig: deps.retrieval,
    ...(deps.graphRanker !== undefined
      ? { graphRanker: deps.graphRanker }
      : {}),
    ...(deps.reranker !== undefined ? { reranker: deps.reranker } : {}),
    // The executor opens no pool until a query actually dials the ledger
    // (lazy `pg` discipline), so building it here costs a non-sql server
    // nothing. Absent key = not provisioned = the typed sql exit.
    ...(deps.businessLedger !== undefined
      ? { businessQuery: new BusinessQueryExecutor(deps.businessLedger) }
      : {}),
    // The structured reader rides the scope seam the backends already expose, so
    // it inherits the same authorized-context mint rather than a second one.
    ...buildStructuredReaderSlot(deps),
    debug,
  };
}

/**
 * The structured reader this backend and host can serve, or nothing.
 *
 * Four capabilities are required together and none alone is usable: a scope seam
 * to mint with, a cursor key to sign a cursor, an evidence store to mint the
 * references a row is cited by, and the identity the host bound to THIS
 * connection. A seam with no key cannot sign a cursor; a seam with no evidence
 * store could only answer with the empty references that make every non-empty
 * page refuse; and all three with no identity would answer as the process's own
 * authority, which is the one answer B1 forbids.
 *
 * Its own function so the gate is assertable and `buildRetrieveDeps` stays a
 * wiring map: which capabilities this server HAS is decided here, and nothing
 * here decides WHO is asking.
 */
function buildStructuredReaderSlot(
  deps: Pick<ServerDeps, "storage" | "queryCursorKey" | "queryIdentity">
): { readonly structuredReader?: StructuredQueryReader } {
  const authority = supportsStructuredQueryScope(deps.storage);
  // Read structurally, the way the evidence dispatcher reads its own, because
  // `StorageBackend` is chunks-only and both seams are optional extensions.
  const grants = supportsEvidenceStore(deps.storage) ? deps.storage : undefined;
  if (
    authority === undefined ||
    grants === undefined ||
    deps.queryCursorKey === undefined ||
    deps.queryIdentity === undefined
  ) {
    return {};
  }
  return {
    structuredReader: buildStructuredQueryReader(
      authority,
      grants,
      new PgStructuredQueryStorage(
        authority,
        Buffer.from(deps.queryCursorKey, "utf8")
      ),
      deps.queryIdentity
    ),
  };
}

/**
 * Pick the retrieve rerank adapter the production server actually calls.
 * Dedicated HTTP URL wins when present (quality-stack T2); otherwise the
 * MiniMax/Anthropic LLM adapter from slice 0. Neither → no adapter (fail-start
 * already refused a default-on boot without one of these).
 */
export function buildRetrieveReranker(
  env: Pick<GraphragEnv, "rerankUrl" | "rerank">
): ServerDeps["reranker"] {
  if (env.rerankUrl !== undefined) {
    return createHttpChunkReranker(env.rerankUrl);
  }
  if (env.rerank !== undefined) {
    return createAnthropicChunkReranker(env.rerank);
  }
  return undefined;
}

/**
 * A seam this adapter does not serve. Reaching one means an authoritative
 * write or read was routed to the derived-index layer, so the refusal is a
 * typed ConfigError naming where the call belongs rather than a silent
 * success or a bare Error.
 *
 * `Promise<never>` on purpose: it satisfies every async method signature in
 * `StorageBackend`, so one helper covers seams of differing arity and return
 * types without a cast.
 *
 * The adapter's object literal below stays explicit — every key spelled out —
 * rather than being generated from a name list: that is what makes the
 * compiler check each seam against `LexicalStorageBackend`. Only the
 * message construction is shared.
 */
function unimplementedSeam(seam: string, hint: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new ConfigError(
        `precision-derived lexical backend does not implement ${seam}; ${hint}`
      )
    );
}

/**
 * Adapt a `PrecisionIndexer` to the `LexicalStorageBackend` shape consumed by
 * the BM25 arm.
 *
 * `PrecisionIndexer` is the broader derived-index port (chunks + entities
 * + invalidation); the lexical arm only ever reads `searchLexical`. Wrapping
 * keeps `LexicalStorageBackend` — which the BM25 arm and several tests
 * consume — unchanged while letting the same `PrecisionIndexer` instance
 * double as the seed-finding entity port (entityLexical).
 *
 * `upsert` / `search` / `close` are intentionally unimplemented: the lexical
 * arm never calls them, and the orchestrator picks `deps.storage` for vector
 * searches via the standard path. A call here would mean a wiring bug.
 */
function lexicalAdapterFromPrecision(
  precision: PrecisionIndexer
): LexicalStorageBackend {
  return {
    upsert: unimplementedSeam(
      "upsert",
      "use storage.upsert for authoritative writes"
    ),
    search: unimplementedSeam(
      "vector search",
      "use storage.search for vector recall"
    ),
    searchLexical: (query: string, opts: SearchOptions) =>
      precision.searchLexical(query, opts),
    close: () => precision.close(),
    // Operator-console T3 source-doc seams are not the lexical arm's
    // concern. A caller reaching them through this adapter has routed
    // a write/read to the wrong layer; surface a typed refusal.
    upsertSourceDoc: unimplementedSeam(
      "upsertSourceDoc",
      "use storage.upsertSourceDoc for authoritative writes"
    ),
    deleteChunksForSourceDoc: unimplementedSeam(
      "deleteChunksForSourceDoc",
      "use storage.deleteChunksForSourceDoc for authoritative rebuilds"
    ),
    listChunksBySourceDoc: unimplementedSeam(
      "listChunksBySourceDoc",
      "use storage.listChunksBySourceDoc for authoritative reads"
    ),
    markSourceDocReady: unimplementedSeam(
      "markSourceDocReady",
      "use storage.markSourceDocReady for authoritative status writes"
    ),
    recordSourceDocFailure: unimplementedSeam(
      "recordSourceDocFailure",
      "use storage.recordSourceDocFailure for authoritative status writes"
    ),
  };
}

/**
 * Build the storage + embedding dependencies for one server instance.
 *
 * Embedder selection is key-presence-driven rather than an explicit mode
 * knob: an operator who supplies an embedding API key wants real embeddings,
 * and one who does not cannot get them anyway. The production server uses an
 * unavailable typed embedder in that case: ingest fails visibly and retrieve
 * can skip the vector arm without manufacturing evidence.
 *
 * Storage selection: pgvector (T8) is dynamically imported so a memory-mode
 * user never pays for the `pg` dependency. The dynamic import is wrapped in
 * a try so a missing optional dependency surfaces as ConfigError with a
 * clear "install pg" hint instead of an opaque module-not-found at startup.
 */
async function buildDeps(env: GraphragEnv): Promise<ServerDeps> {
  let storage: StorageBackend & StorageReadPort;
  if (env.storage === "pgvector") {
    if (env.dbUrl === undefined) {
      // config.loadEnv already enforces this, but defense-in-depth:
      // buildDeps is also exported-style callable for tests.
      throw new ConfigError(
        "GRAPHRAG_MEMORY_DB_URL is required when GRAPHRAG_MEMORY_STORAGE=pgvector"
      );
    }
    let mod: typeof import("./core/storage/pgvector-backend.js");
    try {
      mod = await import("./core/storage/pgvector-backend.js");
    } catch (err) {
      throw new ConfigError(
        `GRAPHRAG_MEMORY_STORAGE=pgvector requires the optional "pg" dependency — \`npm install pg\` (${(err as Error).message})`
      );
    }
    const backend = new mod.PgvectorBackend(env.dbUrl, env.embedDimensions, {
      embedModel: env.embedModel,
    });
    // Fail before the stdio transport opens: dimension, ANN-index, and
    // embedding-generation boot-guard errors are server-startup failures,
    // not tool responses. The guard replaces the retired drop-and-add
    // dim-align rotation (specs/embedding-generation.md): a desired
    // generation with no open rotate is a typed ConfigError, never a DROP.
    await backend.initialize();
    storage = backend;
  } else {
    storage = new MemoryBackend(env.embedDimensions);
  }

  const precision = createPrecisionLayer(env);

  // Both branches always pass `dimensions` through; the dim value is always
  // required by config so this is just plumbing.
  let embedder: EmbeddingClient;
  let slotEmbedding: SlotEmbeddingSource | undefined;
  if (env.embedApiKey) {
    // loadEnv already enforces both when a key is present; defense-in-depth
    // mirrors the dbUrl check above (buildDeps is also callable from tests).
    if (env.embedBaseUrl === undefined || env.embedModel === undefined) {
      throw new ConfigError(
        "GRAPHRAG_MEMORY_EMBED_BASE_URL and GRAPHRAG_MEMORY_EMBED_MODEL are required when an embedding API key is configured"
      );
    }
    embedder = new NineRouterEmbedder({
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      apiKey: env.embedApiKey,
      dimensions: env.embedDimensions,
    });
    slotEmbedding = createSlotSourceFromGraphragEnv(env, embedder);
  } else embedder = new UnavailableEmbedder();

  // Thread the validated retrieval config into the server deps so
  // createServer() can pass it as retrieveConfig to retrieveTool.
  //
  // The ranker is constructed, not connected: `createNeo4jPprRanker` dials
  // Neo4j on the first ranking, so an unreachable sidecar degrades one
  // retrieve instead of stopping the server from starting.
  const reranker = buildRetrieveReranker(env);
  return {
    embedder,
    ...(slotEmbedding !== undefined ? { slotEmbedding } : {}),
    storage,
    ...buildIndexJobSeams(storage),
    ...(precision !== undefined ? { precision } : {}),
    retrieval: env.retrieval,
    ...(env.neo4j !== undefined
      ? { graphRanker: createNeo4jPprRanker(env.neo4j) }
      : {}),
    ...(reranker !== undefined ? { reranker } : {}),
    ...(env.businessLedgerUrl !== undefined
      ? {
          businessLedger: {
            connectionString: env.businessLedgerUrl,
            // Scopes are what this build's permitted templates can answer,
            // never what the request claims (spec §5.2 v1: there is no
            // scope field on the call to forge).
            authorizedScopes: BUSINESS_LEDGER_AUTHORIZED_SCOPES,
          },
        }
      : {}),
    // Read straight from the environment rather than through the config loader:
    // it authenticates cursors this process mints, so it is deployment state
    // like the evidence identity binding, not a retrieval tuning knob.
    ...(process.env.IKNOW_QUERY_CURSOR_KEY !== undefined
      ? { queryCursorKey: process.env.IKNOW_QUERY_CURSOR_KEY }
      : {}),
    // The host's half of B1's binding, and the last step on this path that
    // touches a process global. What the reader then receives is this object, not
    // the environment — see `ServerDeps.queryIdentity` for why that matters and
    // for why reading it here rather than per call is what makes it per
    // connection.
    queryIdentity: queryScopeIdentityFromEnv(process.env),
  };
}

/**
 * Assert the seams the durable index-job tools need on the selected backend
 * and adapt the read port to the shape those tools ask for.
 *
 * Loud at wiring rather than per call on purpose: `submit_index_job` and
 * `poll_index_job` are in the catalog unconditionally, so a backend without a
 * job ledger or without the 档 C singleton must stop the server at startup —
 * a host must never see a submit that looks accepted but cannot persist.
 *
 * Exported so the read-port and C-seam adapters are assertable against a real
 * backend without a live Postgres (tests/tools/index-job.test.ts) — the same
 * reason `buildRetrieveDeps` / `buildExtractDeps` are exported.
 */
export function buildIndexJobSeams(
  storage: StorageBackend & StorageReadPort
): Pick<ServerDeps, "indexJobs" | "communityState" | "indexJobReadPort"> {
  if (!supportsIndexJobStore(storage)) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_STORAGE backend has no index-job ledger: submit_index_job " +
        "and poll_index_job need an IndexJobStore (insertJobOrJoin/getJob)"
    );
  }
  if (!supportsCommunityIndexState(storage)) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_STORAGE backend exposes no community_index_state singleton: " +
        "poll_index_job must report 档 C readiness beside the job row"
    );
  }
  const indexJobs: IndexJobStore = storage;
  return {
    indexJobs,
    communityState: storage,
    indexJobReadPort: {
      async getSourceDoc(sourceRef) {
        const read = await storage.getSourceDoc(sourceRef);
        // The port's NOT_FOUND answer and a genuinely absent row are the same
        // fact to the tool: nothing was ever pushed under this locator.
        return read.ok ? read.value : null;
      },
    },
  };
}

/**
 * Build the extract tool's dependencies from the loaded env.
 *
 * Pool lifecycle: the pg.Pool is created LAZILY on the first extract call
 * that dials the database (`import("pg")` mirrors the memory-mode posture
 * of buildDeps — a server that never calls extract never loads the driver).
 * A server without GRAPHRAG_MEMORY_DB_URL gets no pool at all: extract
 * answers a typed per-call configuration error and the server still boots.
 * Once created, the pool lives for the server's lifetime — the same
 * process-scoped posture as the pgvector backend's pool, so there is no
 * per-call pool to leak (extract runs inside the caller's await, not in a
 * detached task).
 *
 * LLM credentials ride the parsed ANTHROPIC block (`env.rerank` — the same
 * ANTHROPIC_AUTH_TOKEN / GRAPHRAG_MEMORY_ANTHROPIC_* family the extract CLI
 * reads raw from process.env, here already trimmed and defaulted by
 * loadEnv). Embedding credentials come straight from the embed block.
 * Missing credentials do NOT fail the build: extract reports a typed
 * per-call error instead (SC9 — never a fake client), which keeps the
 * offline server booting for the other tools.
 *
 * Precision: the server's ONE ElasticsearchPrecisionLayer — the one
 * `buildDeps` already constructed from `env.elasticsearch` — is threaded
 * in by the caller, so a single ES client is shared by every tool on this
 * server (never rebuilt from env here). Absent when ES is unconfigured;
 * extract's ES mirror is fail-open inside the core pipeline either way.
 *
 * Exported so the wiring is directly assertable without Postgres
 * (tests/index.test.ts).
 */
export function buildExtractDeps(
  env: GraphragEnv,
  logger: ReturnType<typeof createLogger>,
  precision?: PrecisionIndexer
): ExtractDeps {
  // The extraction LLM credentials ride the parsed ANTHROPIC block: despite
  // its historical name, `env.rerank` IS the ANTHROPIC_AUTH_TOKEN /
  // GRAPHRAG_MEMORY_ANTHROPIC_* family the extract CLI reads raw from
  // process.env. The config field name and env vars are frozen; the local
  // alias keeps the dual role readable at the use site.
  const anthropicLlmCreds = env.rerank;
  return {
    llmEnv: {
      authToken: anthropicLlmCreds?.apiKey,
      baseUrl: anthropicLlmCreds?.baseUrl,
      model: anthropicLlmCreds?.model,
    },
    embedderEnv: {
      apiKey: env.embedApiKey,
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      dimensions: env.embedDimensions,
    },
    ...(env.dbUrl !== undefined
      ? { pool: createLazyPgExtractPool(env.dbUrl) }
      : {}),
    ...(precision !== undefined ? { precision } : {}),
    // Write-time supersede switch: the MCP tool path reads the same
    // validated env field the offline CLI does, so one operator setting
    // governs both entry points. Defaults ON in loadEnv (ADR-0009);
    // explicit off is the test/escape hatch.
    writeTimeSupersede: env.extractWriteTimeSupersede,
    logger,
  };
}

/**
 * A pool placeholder that pays for the pg driver only when extract actually
 * dials the database. The memoized promise keeps concurrent first calls from
 * constructing two pools (the ??= check is synchronous, so JS's
 * single-threaded event loop makes it atomic).
 */
function createLazyPgExtractPool(connectionString: string): ExtractPool {
  let pool: Promise<import("pg").Pool> | undefined;
  return {
    connect: () => {
      pool ??= import("pg").then(({ Pool }) => new Pool({ connectionString }));
      return pool.then((p) => p.connect());
    },
  };
}

export async function createServer(): Promise<McpServer> {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);
  const deps = await buildDeps(env);
  // Debug gate: DEBUG=1 surfaces the retrieve envelope's `debug` payload.
  // Absent → no debug key.
  const debug = process.env.DEBUG === "1";
  const registry = buildRegistry([
    ingestTool({ ...deps, logger }),
    invalidationTool(deps),
    pushTool({ ...deps, logger }),
    // buildDeps' single ES precision layer is threaded through so extract
    // shares it instead of constructing a second ES client from env.
    extractTool(buildExtractDeps(env, logger, deps.precision)),
    retrieveTool(buildRetrieveDeps(deps, debug)),
    // Operator-console T4: pure read tool over the same deps — the
    // StorageReadPort is implemented by both production backends.
    readSourceTool(deps),
    // Durable index-job handoff: submit queues one content version's graph
    // re-index, poll reads it. Neither runs a stage, so push stays the only
    // writer of `source_documents.status` and the C runner the only writer of
    // `community_index_state`.
    submitIndexJobTool({
      jobStore: deps.indexJobs,
      readPort: deps.indexJobReadPort,
    }),
    pollIndexJobTool({
      jobStore: deps.indexJobs,
      communityState: deps.communityState,
    }),
  ]);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  for (const tool of registry.values()) {
    registerOne(server, tool, logger);
  }

  // The private Evidence capability is a custom JSON-RPC request method, not a
  // registered tool, so `tools/list` above is unchanged by its presence. It is
  // registered only when the selected storage carries the authorized-scope
  // seam: without that seam there is nothing to mint a trusted context with, and
  // an Evidence call must be refused rather than answered from another authority.
  const evidenceAuthority = supportsEvidenceScopeAuthority(deps.storage);
  if (evidenceAuthority !== undefined) {
    const dispatcher = createEvidenceDispatcher({
      authority: evidenceAuthority,
      binding: process.env,
    });
    server.server.setRequestHandler(
      EVIDENCE_PRIVATE_METHOD,
      { params: z.unknown() },
      async (request: unknown) =>
        (await dispatcher.handle(request)) as unknown as {
          [key: string]: unknown;
        }
    );
  }

  logger.info("server constructed", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: Array.from(registry.keys()),
    storage: env.storage,
    // Never log the key itself — only whether one was supplied.
    embedder: env.embedApiKey ? "9router" : "unavailable",
  });
  return server;
}

function registerOne(
  server: McpServer,
  tool: ToolRegistration,
  logger: ReturnType<typeof createLogger>
): void {
  // The SDK accepts a Zod object schema directly via McpServer.registerTool;
  // it converts to JSON Schema internally. We pass the full schema (not
  // `.shape`) so the SDK's own validation stays the source of truth.
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    async (input) => {
      try {
        return await tool.handler(input);
      } catch (err) {
        // Mirror v2's internal `createToolError` shape: a plain text
        // content block with isError:true. v2's SDK would do this for us
        // (server/src/server/mcp.ts createToolError), but we keep the
        // try/catch to also surface stderr via the logger — hosts without
        // structured logging benefit from the observation.
        const message = redactDiagnostic(
          err instanceof Error ? err.message : err
        );
        logger.error("handler threw", { tool: tool.name, error: message });
        // A structured-query refusal carries its own closed envelope
        // (`iknow.structured_error`, spec §Typed errors) rather than the
        // legacy named-token shape below: the host classifies from
        // `error.code` + `error.retryable`, and a structured failure that
        // degraded into prose or an empty success would be
        // indistinguishable from a no-match.
        if (err instanceof StructuredQueryError) {
          return textResult(JSON.stringify(structuredErrorEnvelope(err)), true);
        }
        // A failure that declares a stable token publishes it as the JSON
        // body's `error` field, matching the read_source error results, so a
        // host classifies from structure rather than from prose. Only such a
        // failure changes shape; every other isError result keeps the plain
        // text block above.
        const failureToken = failureTokenOf(err);
        if (failureToken !== undefined) {
          return textResult(
            JSON.stringify({ error: failureToken, message }),
            true
          );
        }
        return textResult(message, true);
      }
    }
  );
}

export async function main(argv?: readonly string[]): Promise<void> {
  // Plan D0 I-T3: argv is validated up front so an operator typo can't
  // silently spin up a stdio MCP session that just hangs. The argv
  // parameter is injectable for tests; production callers leave it
  // undefined and we read process.argv.slice(2).
  const parsed = parseStdioEntry(argv ?? process.argv.slice(2));
  if (!parsed.ok) {
    writeStderr(`iknow-memory: ${parsed.error}\n`);
    process.exit(EXIT_CODES.BAD_CONFIG);
  }

  // Config first, and on its own: a ConfigError is an operator mistake, not
  // a crash, so it exits with BAD_CONFIG and a one-line message rather than
  // the stack trace the FATAL_RUNTIME path prints. createServer() re-reads
  // the env (it is a pure function of process.env), so this call both
  // validates early and gives us a logger before the transport opens.
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stderr only; stdout is reserved for the MCP transport.
      writeStderr(`iknow-memory config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }
  const logger = createLogger(env.logLevel);

  // Stage 0 is stdio-only (map #33 defers HTTP to T-005/#36). Transport is
  // not a runtime knob, so there is no transport-rejection path here.
  let server: McpServer;
  try {
    server = await createServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`iknow-memory config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio transport connected", { server: SERVER_NAME });
}

// Run only when invoked directly (not when imported for tests).
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  // ESM entry path ends with /src/index.ts (dev) or /dist/index.js (prod).
  return arg1.endsWith("index.ts") || arg1.endsWith("index.js");
})();

if (isMain) {
  main().catch((err) => {
    // stderr only; never write to stdout (reserved for MCP transport).
    writeStderr(`iknow-memory fatal: ${redactDiagnostic(err)}\n`);
    process.exit(EXIT_CODES.FATAL_RUNTIME);
  });
}
