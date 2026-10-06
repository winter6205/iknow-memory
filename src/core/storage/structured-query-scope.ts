/**
 * The Query scope resolver: the composition seam P1-D1 decided on.
 *
 * Query takes its OWN seam rather than reusing the Evidence binding, because the
 * two answer different questions. Evidence asks which retained grant this
 * process may read, and its answer is fixed for the process lifetime. A Query
 * reader asks which scope and authorized source subset this request may see, and
 * its answer has to be per request so the cursor it mints can bind a read
 * revision. One binding cannot return both without a union whose members are
 * each wrong for one caller. The reasoning is recorded in
 * `fin/docs/validation/2026-10-07-p1-query-reader-mint-point-decision.md`.
 *
 * What IS reused is the mint itself. `createAuthorizedContext` freezes the
 * context and records it in a WeakMap keyed on object identity, and
 * `scopeAuthorityOf` refuses anything absent from that map. So a context that
 * did not come through this file cannot reach a lock, and the reader's entry gate
 * is already unforgeable without any new mechanism.
 *
 * The values come from the environment, never from the request. A model that
 * could name its own scope, source set or revision would be able to read
 * another principal's data, so there is no field on the query that reaches here.
 */
import type {
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeUnitOfWork,
} from "./structured-scope-types.js";

/** The environment names the Query scope is resolved from. */
export const QUERY_SCOPE_ENV_VARS = {
  actorId: "IKNOW_QUERY_ACTOR_ID",
  ownerScopeBinding: "IKNOW_QUERY_OWNER_SCOPE",
  readerBinding: "IKNOW_QUERY_READER",
  sourceRefs: "IKNOW_QUERY_SOURCE_REFS",
  authorizationRevision: "IKNOW_QUERY_AUTH_REVISION",
  deadlineAt: "IKNOW_QUERY_DEADLINE_AT",
} as const;

/** The read environment the resolver inspects; the shape `process.env` has. */
export type QueryScopeEnv = Readonly<Record<string, string | undefined>>;

/** A fully resolved Query scope, or the reason it is not resolvable. */
export type ResolvedQueryScope =
  | { readonly context: AuthorizedScopeContext }
  | { readonly refusal: string };

function requireField(
  env: QueryScopeEnv,
  name: string
): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw;
}

/**
 * Mint the Query reader's authorized context for this deployment.
 *
 * Every member is required and there is no fallback. A partially configured
 * scope is an unprovisioned capability, not a narrower one: returning a context
 * with a guessed owner or an empty source set would report an authorized empty
 * result for a corpus the operator meant to expose, which is the SPEC's
 * "never an empty-but-successful fallback for an incomplete read" case wearing
 * a different hat.
 */
export function resolveQueryScope(
  authority: AuthorizedScopeUnitOfWork,
  env: QueryScopeEnv
): ResolvedQueryScope {
  const actorId = requireField(env, QUERY_SCOPE_ENV_VARS.actorId);
  const ownerScopeBinding = requireField(
    env,
    QUERY_SCOPE_ENV_VARS.ownerScopeBinding
  );
  const readerBinding = requireField(env, QUERY_SCOPE_ENV_VARS.readerBinding);
  const sourceRefs = requireField(env, QUERY_SCOPE_ENV_VARS.sourceRefs);
  const authorizationRevision = requireField(
    env,
    QUERY_SCOPE_ENV_VARS.authorizationRevision
  );
  const deadlineAt = requireField(env, QUERY_SCOPE_ENV_VARS.deadlineAt);

  const missing: string[] = [
    actorId === undefined ? QUERY_SCOPE_ENV_VARS.actorId : "",
    ownerScopeBinding === undefined
      ? QUERY_SCOPE_ENV_VARS.ownerScopeBinding
      : "",
    readerBinding === undefined ? QUERY_SCOPE_ENV_VARS.readerBinding : "",
    sourceRefs === undefined ? QUERY_SCOPE_ENV_VARS.sourceRefs : "",
    authorizationRevision === undefined
      ? QUERY_SCOPE_ENV_VARS.authorizationRevision
      : "",
    deadlineAt === undefined ? QUERY_SCOPE_ENV_VARS.deadlineAt : "",
  ].filter((name) => name !== "");
  if (missing.length > 0) {
    return {
      refusal: `the Query scope is unprovisioned; absent: ${missing.join(", ")}`,
    };
  }

  const authorizedSourceRefs = (sourceRefs as string)
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "");
  if (authorizedSourceRefs.length === 0) {
    return {
      refusal: `${QUERY_SCOPE_ENV_VARS.sourceRefs} names no source; an empty set would read as an authorized empty corpus`,
    };
  }

  const input: AuthorizedScopeContextInput = {
    actorId: actorId as string,
    ownerScopeBinding: ownerScopeBinding as string,
    readerBinding: readerBinding as string,
    authorizedSourceRefs,
    authorizationRevision: authorizationRevision as string,
    deadlineAt: deadlineAt as string,
  };
  return { context: authority.createAuthorizedContext(input) };
}
