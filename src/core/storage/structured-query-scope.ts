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
 * The values come from the host, never from the request. A model that could name
 * its own scope, source set or revision would be able to read another
 * principal's data, so there is no field on the query that reaches here. They
 * come from the host as a `QueryScopeIdentity` ARGUMENT rather than out of an
 * environment, because B1 binds identity per connection with no process-level
 * fallback: an environment read here is one identity for every connection in the
 * process, whatever the transport happens to do about it.
 */
import type {
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeUnitOfWork,
} from "./structured-scope-types.js";

/** The environment names the host reads each binding member from. */
export const QUERY_SCOPE_ENV_VARS = {
  actorId: "IKNOW_QUERY_ACTOR_ID",
  ownerScopeBinding: "IKNOW_QUERY_OWNER_SCOPE",
  readerBinding: "IKNOW_QUERY_READER",
  sourceRefs: "IKNOW_QUERY_SOURCE_REFS",
  authorizationRevision: "IKNOW_QUERY_AUTH_REVISION",
  deadlineAt: "IKNOW_QUERY_DEADLINE_AT",
  /**
   * Deliberately the EVIDENCE-side name, not a seventh `IKNOW_QUERY_*` one.
   *
   * The consumer is a property of the transport's deployment, not of one
   * channel: the same host variable names the stream for both the Evidence
   * channel and the Query issuer that mints its grants, so one host setting
   * gives one consumer id rather than two that could disagree. A second name
   * would make "which stream do these grants belong to" a per-channel
   * question, which is precisely what ADR 0097 §2.1's stored-not-sent
   * `consumer_id` exists to prevent.
   */
  consumerId: "IKNOW_EVIDENCE_CONSUMER_ID",
} as const;

/** The read environment the host reads a binding from; `process.env`'s shape. */
export type QueryScopeEnv = Readonly<Record<string, string | undefined>>;

/**
 * The Query identity ONE connection is bound to, injected by the host.
 *
 * A named record rather than an environment, because B1 binds identity per
 * connection with "no process-level fallback and no default scope": a value read
 * out of a process-wide environment is one identity for every connection in that
 * process, so a host serving two connections from one process would hand the
 * second the first's authority. The host reads whatever channel it uses — the
 * per-session `env=` a stdio child is spawned with, an HTTP session header, a
 * per-connection container — and passes the result here as an argument, so two
 * connections are two objects and two identities with nothing global mutated
 * between them.
 *
 * Every member is optional so "the host injected no binding" is a value this type
 * can hold. That is the state B1's verification clause is about: a session with
 * no injected identity must be refused BY NAME, which a type that required all
 * six could not express.
 */
export interface QueryScopeIdentity {
  readonly actorId?: string;
  readonly ownerScopeBinding?: string;
  readonly readerBinding?: string;
  /** Comma-separated, the same encoding the host's own variable uses. */
  readonly sourceRefs?: string;
  readonly authorizationRevision?: string;
  readonly deadlineAt?: string;
  /**
   * Which per-consumer invalidation stream this connection's grants belong to.
   *
   * NOT a scope member, unlike the six above: it never enters
   * `resolveQueryScope` and never reaches the authorized context, because which
   * stream to publish an invalidation on says nothing about what this
   * connection may read. It rides on the same host-injected object because the
   * host sets both from the same channel and the grant needs it, so this is
   * where an unbound host's absence is representable. Absent is a per-call
   * refusal by the issuer, not a default consumer.
   */
  readonly consumerId?: string;
}

/**
 * The members the host may bind, as a key map.
 *
 * Typed `Record<keyof QueryScopeIdentity, true>` for the reason
 * `EVIDENCE_STORE_METHODS` is typed in `backend.ts`: a member added to the
 * identity without an entry here is a compile error, which is the only thing that
 * can notice. The reverse map then derives the environment names from the same
 * key, so a member and the variable the host reads it from cannot drift apart.
 *
 * `consumerId` is listed because the host sets it here, but it is deliberately
 * NOT one of the six `resolveQueryScope` requires: a missing consumer is an
 * unissuable grant, not an unprovisioned scope, and collapsing the two would
 * report a binding problem as a reading problem.
 */
const QUERY_SCOPE_MEMBERS: Record<keyof QueryScopeIdentity, true> = {
  actorId: true,
  ownerScopeBinding: true,
  readerBinding: true,
  sourceRefs: true,
  authorizationRevision: true,
  deadlineAt: true,
  consumerId: true,
};

/** The environment variable each member is read from, derived not restated. */
const MEMBER_ENV_VARS: Readonly<Record<keyof QueryScopeIdentity, string>> =
  Object.fromEntries(
    (Object.keys(QUERY_SCOPE_MEMBERS) as (keyof QueryScopeIdentity)[]).map(
      (member) => [member, QUERY_SCOPE_ENV_VARS[member]]
    )
  ) as Record<keyof QueryScopeIdentity, string>;

/**
 * Read one connection's binding out of the channel the host uses.
 *
 * The HOST's half of the binding, so it lives beside the member list rather than
 * in the composition layer: the names stay in one file, an absent variable becomes
 * an absent member (never a default), and a blank one is treated as absent so
 * `IKNOW_QUERY_ACTOR_ID=""` cannot pass as an injected identity.
 */
export function queryScopeIdentityFromEnv(
  env: QueryScopeEnv
): QueryScopeIdentity {
  const read = (member: keyof QueryScopeIdentity): string | undefined => {
    const raw = env[MEMBER_ENV_VARS[member]];
    return raw === undefined || raw.trim() === "" ? undefined : raw;
  };
  return {
    actorId: read("actorId"),
    ownerScopeBinding: read("ownerScopeBinding"),
    readerBinding: read("readerBinding"),
    sourceRefs: read("sourceRefs"),
    authorizationRevision: read("authorizationRevision"),
    deadlineAt: read("deadlineAt"),
    consumerId: read("consumerId"),
  };
}

/** A fully resolved Query scope, or the reason it is not resolvable. */
export type ResolvedQueryScope =
  { readonly context: AuthorizedScopeContext } | { readonly refusal: string };

/** One member as this resolver needs it: present and non-blank, or absent. */
function requireMember(
  identity: QueryScopeIdentity,
  member: keyof QueryScopeIdentity
): string | undefined {
  const raw = identity[member];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/**
 * Mint the Query reader's authorized context for ONE connection.
 *
 * `identity` is the binding the host injected for the connection this reader
 * serves, so "which actor is asking" is a property of the connection rather than
 * of the process: two connections carrying two bindings get two contexts, and
 * nothing here reads an environment, a global, or a request field.
 *
 * Every member is required and there is no fallback. A partially injected
 * binding is an unprovisioned capability, not a narrower one: returning a
 * context with a guessed owner or an empty source set would report an authorized
 * empty result for a corpus the operator meant to expose, which is the SPEC's
 * "never an empty-but-successful fallback for an incomplete read" case wearing
 * a different hat. The refusal names the absent members, because a deployment
 * that cannot read has to know which binding to inject.
 */
export function resolveQueryScope(
  authority: AuthorizedScopeUnitOfWork,
  identity: QueryScopeIdentity
): ResolvedQueryScope {
  const actorId = requireMember(identity, "actorId");
  const ownerScopeBinding = requireMember(identity, "ownerScopeBinding");
  const readerBinding = requireMember(identity, "readerBinding");
  const sourceRefs = requireMember(identity, "sourceRefs");
  const authorizationRevision = requireMember(
    identity,
    "authorizationRevision"
  );
  const deadlineAt = requireMember(identity, "deadlineAt");

  const missing: string[] = [
    actorId === undefined ? "actorId" : "",
    ownerScopeBinding === undefined ? "ownerScopeBinding" : "",
    readerBinding === undefined ? "readerBinding" : "",
    sourceRefs === undefined ? "sourceRefs" : "",
    authorizationRevision === undefined ? "authorizationRevision" : "",
    deadlineAt === undefined ? "deadlineAt" : "",
  ].filter((member) => member !== "");
  if (missing.length > 0) {
    return {
      refusal:
        "the Query identity this connection was given is unprovisioned; " +
        `absent: ${missing.join(", ")}`,
    };
  }

  const authorizedSourceRefs = (sourceRefs as string)
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "");
  if (authorizedSourceRefs.length === 0) {
    return {
      refusal:
        "sourceRefs names no source; an empty set would read as an " +
        "authorized empty corpus",
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
