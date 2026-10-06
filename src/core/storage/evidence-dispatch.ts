/**
 * The session-scoped private Evidence dispatcher.
 *
 * This module is the only place that turns a JSON-RPC `corpus_evidence` request
 * into an authorized Evidence read, and it is deliberately registered as a
 * **custom request method** rather than as a tool. The SDK's `tools/list` is
 * built from the registered-tool map, so a method handler is invisible to it:
 * the model-visible surface is unchanged by construction, not by a frozen
 * expectation. That is the property T39 could only freeze and assert; here it is
 * structural.
 *
 * It is equally the only place that resolves the trusted identity. The binding
 * is read from the process environment — the transport — **once per session**,
 * on the first Evidence request, and the result is memoized. Two consequences
 * matter:
 *
 *  - The binding cannot be changed under a live session. The child was spawned
 *    with an explicit `env=`, so the values are fixed at launch; re-reading them
 *    per request would only invite a caller to believe it could.
 *  - An unbound session memoizes its **refusal**, not a fallback. There is no
 *    code path here that produces a context when the transport did not supply
 *    one, which is the whole of the B1 decision.
 *
 * Every outcome is returned as a value rather than thrown across the transport,
 * so a refusal reaches the caller as a typed envelope with no row field in it —
 * there is no partial-success shape to leak through.
 */
import {
  StructuredScopeError,
  structuredScopeCodeOf,
  type AuthorizedScopeContext,
} from "./structured-scope-types.js";
import { resolveEvidenceScopeContext } from "./evidence-binding.js";
import type { EvidenceScope } from "./evidence-read.js";
import {
  EVIDENCE_PRIVATE_METHOD,
  EVIDENCE_REFUSAL_REASON,
  parseEvidenceRequest,
  readPrivateEvidence,
  type EvidenceEnvelope,
} from "./evidence-read.js";

/** The transport's environment subset the binding is resolved from. */
export type EvidenceBindingSource = Readonly<Record<string, string | undefined>>;

/** The one authority that may mint a trusted context and run a unit of work. */
export type EvidenceDispatchAuthority = EvidenceScope;

/** A backend that composes the authorized-scope seam it minted from. */
export interface EvidenceScopeCarrier {
  readonly structuredScopeUnitOfWork: EvidenceDispatchAuthority;
}

/**
 * Narrow a storage backend to the one authority that may mint a trusted context.
 *
 * Structural, like `supportsEvidenceStore`: it checks for the seam's own minting
 * and transaction methods rather than for a class name, so a backend that
 * composes the seam is recognized without this module importing it. The seam
 * hangs off the backend as `structuredScopeUnitOfWork`, which is why the backend
 * itself is not the authority -- reading identity off the wrong object is exactly
 * how a session would end up with a context nobody else recognizes as trusted.
 *
 * A backend without the seam yields `undefined` and the caller registers
 * nothing: an Evidence call is then refused as method-not-found rather than
 * answered from an authority this server never composed.
 */
export function supportsEvidenceScopeAuthority(
  candidate: unknown
): EvidenceDispatchAuthority | undefined {
  const seam = (candidate as Partial<EvidenceScopeCarrier> | null | undefined)
    ?.structuredScopeUnitOfWork as Partial<EvidenceDispatchAuthority> | undefined;
  return typeof seam?.createAuthorizedContext === "function" &&
    typeof seam.withAuthorizedScope === "function"
    ? (seam as EvidenceDispatchAuthority)
    : undefined;
}

/** The one JSON-RPC method name, re-exported so registration cannot drift. */
export { EVIDENCE_PRIVATE_METHOD };

function scopeRefusal(error: unknown): EvidenceEnvelope {
  const scopeError =
    error instanceof StructuredScopeError ? error : undefined;
  const code = scopeError ? structuredScopeCodeOf(scopeError.code) : undefined;
  return {
    schema: "iknow.evidence_result",
    schema_version: 1,
    error: {
      // An identity refusal keeps its scope code: it is already a member of the
      // closed STRUCTURED_SCOPE_FAILURE_CODES set, so no set is widened to carry
      // it. An unclassifiable fault is reported as backend_unavailable, the same
      // reading the authorized-scope seam gives it.
      code: code ?? "backend_unavailable",
      reason: EVIDENCE_REFUSAL_REASON.TRUSTED_BINDING_UNRESOLVED,
      message:
        error instanceof Error
          ? error.message
          : "the trusted identity binding could not be resolved",
      retryable: false,
    },
  };
}

function refusalEnvelope(error: unknown): EvidenceEnvelope {
  const named = error as { code?: unknown; reason?: unknown; message?: unknown };
  return {
    schema: "iknow.evidence_result",
    schema_version: 1,
    error: {
      code: typeof named.code === "string" ? named.code : "backend_unavailable",
      reason: (typeof named.reason === "string"
        ? named.reason
        : "backend_unavailable") as never,
      message:
        typeof named.message === "string"
          ? named.message
          : String(error),
      retryable: false,
    },
  };
}

export interface EvidenceDispatcherOptions {
  readonly authority: EvidenceDispatchAuthority;
  readonly binding: EvidenceBindingSource;
  /** The session instant used for expiry; supplied by the caller. */
  readonly now?: () => string;
}

export interface EvidenceDispatcher {
  /** Answer one private Evidence request. Never throws for a refusal. */
  handle(request: unknown): Promise<EvidenceEnvelope>;
  /** Whether this session resolved an identity at all. */
  readonly bound: boolean;
}

/**
 * Build the dispatcher for one MCP session.
 *
 * `authority` must be the *same* seam instance the rest of the composition uses,
 * because `scopeAuthorityOf` recognizes a context by the object identity of the
 * authority that minted it. A second seam would mint a second kind of context
 * that the rest of the server cannot recognize as trusted.
 */
export function createEvidenceDispatcher(
  options: EvidenceDispatcherOptions
): EvidenceDispatcher {
  const clock = options.now ?? (() => new Date().toISOString());
  let resolved: AuthorizedScopeContext | undefined;
  let unresolved: EvidenceEnvelope | undefined;

  function context(): AuthorizedScopeContext | undefined {
    if (resolved !== undefined) return resolved;
    if (unresolved !== undefined) return undefined;
    try {
      resolved = resolveEvidenceScopeContext(options.authority, options.binding);
      return resolved;
    } catch (error) {
      unresolved = scopeRefusal(error);
      return undefined;
    }
  }

  return {
    get bound(): boolean {
      return context() !== undefined;
    },
    async handle(request: unknown): Promise<EvidenceEnvelope> {
      const trusted = context();
      if (trusted === undefined) return unresolved as EvidenceEnvelope;
      try {
        const parsed = parseEvidenceRequest(request);
        return await readPrivateEvidence(
          options.authority,
          trusted,
          parsed,
          clock()
        );
      } catch (error) {
        return refusalEnvelope(error);
      }
    },
  };
}
