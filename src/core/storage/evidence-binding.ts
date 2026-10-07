/**
 * The trusted identity binding for the private Evidence channel
 * (specs/structured-corpus-evidence.md "Internal evidence capability"; the B1
 * decision recorded in the Fin worktree at
 * `docs/validation/2026-10-06-b1-trusted-identity-binding-decision.md`).
 *
 * The spec sentence that decides this module's whole shape is: *"Trusted
 * caller/consumer identity is supplied by the transport, never by the model or a
 * stored scope token."* The transport is the child process's launch
 * environment, so the transport is where this module reads identity from — and
 * nowhere else. It reads a **closed allowlist** of variable names, it reads them
 * **once at session initialisation**, and it has **no default**.
 *
 * Why there is no default. `MCPStdioSession` used to spawn its child with no
 * `env=`, so every session in one host process inherited one identity and the
 * authorized subset was a process-wide constant. A silent fallback is the defect
 * itself: an unbound caller would quietly receive *some* scope's authority
 * instead of a refusal. So an absent, partial, or unrecognized binding refuses
 * here, with a code already in `STRUCTURED_SCOPE_FAILURE_CODES`. That set is
 * closed and this file does not widen it.
 *
 * What this module deliberately does NOT do:
 *
 *  - It does not read `clientInfo`, the JSON-RPC initialize params, or anything
 *    else on the message channel. A client asserts those freely, so they carry
 *    no authority.
 *  - It does not accept an identity from a request payload. The request parser
 *    in `evidence-read.ts` refuses an unknown key, so a model-supplied
 *    identity-shaped field is a typed `invalid_input` rather than a silent
 *    ignore.
 *  - It does not mint anything itself. It builds the *input* to
 *    `createAuthorizedContext` and lets the authorized-scope seam mint, because
 *    that seam is the only issuer and `scopeAuthorityOf` refuses a context it
 *    did not mint.
 */
import {
  STRUCTURED_SCOPE_FAILURE_CODES,
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeContextInput,
  type AuthorizedScopeUnitOfWork,
} from "./structured-scope-types.js";

/**
 * The closed set of variables the transport may bind: one entry per field of the
 * authorized context. A variable outside this object is not part of the contract
 * and is never read.
 *
 * The names are deliberately not derived from, and do not mirror, any other
 * environment variable a host sets. An identity whose authority came from a
 * *name* convention would be forgeable by whoever can set a name.
 */
export const TRUSTED_BINDING_ENV_VARS = {
  /** Which binding contract the host speaks; anything else is unresolved. */
  version: "IKNOW_EVIDENCE_BINDING",
  actorId: "IKNOW_EVIDENCE_ACTOR_ID",
  ownerScopeBinding: "IKNOW_EVIDENCE_OWNER_SCOPE",
  readerBinding: "IKNOW_EVIDENCE_READER",
  /** Comma-separated source references this identity may read. */
  sourceRefs: "IKNOW_EVIDENCE_SOURCE_REFS",
  authorizationRevision: "IKNOW_EVIDENCE_AUTH_REVISION",
  deadlineAt: "IKNOW_EVIDENCE_DEADLINE_AT",
  /**
   * Which per-consumer invalidation stream this identity's grants belong to.
   *
   * The eighth member and the only one that is not an identity field: it names
   * the stream, not the actor, which is why ADR 0097 §2.1 stores it and never
   * sends it. It is allowlisted here so it arrives with the same trust the other
   * seven do — from a name the host set deliberately — rather than from a
   * request field a caller could choose.
   */
  consumerId: "IKNOW_EVIDENCE_CONSUMER_ID",
} as const;

/** Every allowlisted name, for a host that builds an explicit child env. */
export const TRUSTED_BINDING_ENV_NAMES: readonly string[] = Object.values(
  TRUSTED_BINDING_ENV_VARS
);

/** The binding contract version this build speaks. */
export const TRUSTED_BINDING_VERSION = "1";

/**
 * One identity as the transport asserted it. This is plain data on purpose: it
 * is not a context, it carries no authority, and nothing can be done with it
 * except hand it to `createAuthorizedContext`.
 */
export interface TrustedIdentityBinding {
  readonly actorId: string;
  readonly ownerScopeBinding: string;
  /**
   * Carried and minted, but never compared on the read path. Authority there is
   * `ownerScopeBinding` + `sourceRefs` + `authorizationRevision`, which decide
   * it completely; this field names the reader inside the owner's lifecycle for
   * view selection. Stated here so a later reader does not mistake an unchecked
   * field for a missing check, and so turning it into a gate is a decision
   * rather than a patch.
   */
  readonly readerBinding: string;
  readonly sourceRefs: readonly string[];
  readonly authorizationRevision: string;
  readonly deadlineAt: string;
  /**
   * Carried to the grant, never compared on the read path and never part of the
   * context's authority — the same standing as `readerBinding`. It is the stream
   * the grant's future invalidation is addressed to, and it exists so a drain can
   * never be told which stream to read from request input.
   */
  readonly consumerId: string;
}

/** The environment subset the resolver is allowed to look at. */
export type TrustedBindingEnv = Readonly<Record<string, string | undefined>>;

/**
 * Read and validate the binding, or refuse.
 *
 * Both failure codes are already members of the closed
 * `STRUCTURED_SCOPE_FAILURE_CODES` set, and this module adds none:
 *
 *  - `access_denied` — the binding is absent, partial, or speaks a version this
 *    build does not implement. This is the single most important refusal in the
 *    channel: it is what an unbound session gets instead of a default scope.
 *  - `invalid_input` — the binding is present but not well formed (a blank
 *    field, an unparseable deadline, no source refs). Still a refusal, and still
 *    never a partial acceptance.
 */
export function readTrustedIdentityBinding(
  env: TrustedBindingEnv
): TrustedIdentityBinding {
  const version = env[TRUSTED_BINDING_ENV_VARS.version];
  if (version === undefined || version === "") {
    throw new StructuredScopeError(
      "access_denied",
      "the private Evidence channel requires a trusted identity binding, and " +
        `none was injected: ${TRUSTED_BINDING_ENV_VARS.version} is absent. ` +
        `Set ${TRUSTED_BINDING_ENV_VARS.version}=${TRUSTED_BINDING_VERSION} ` +
        "plus one variable per allowlisted name " +
        `(${TRUSTED_BINDING_ENV_NAMES.join(", ")}). ` +
        "No default scope is substituted and no unbound read is attempted."
    );
  }
  if (version !== TRUSTED_BINDING_VERSION) {
    throw new StructuredScopeError(
      "access_denied",
      `the trusted identity binding speaks version ${version}, but this ` +
        `build implements version ${TRUSTED_BINDING_VERSION}. An unresolved ` +
        "binding is refused rather than downgraded to an older or a default scope."
    );
  }

  const actorId = requireBindingField(env, TRUSTED_BINDING_ENV_VARS.actorId);
  const ownerScopeBinding = requireBindingField(
    env,
    TRUSTED_BINDING_ENV_VARS.ownerScopeBinding
  );
  const readerBinding = requireBindingField(
    env,
    TRUSTED_BINDING_ENV_VARS.readerBinding
  );
  const authorizationRevision = requireBindingField(
    env,
    TRUSTED_BINDING_ENV_VARS.authorizationRevision
  );
  const deadlineAt = requireBindingField(
    env,
    TRUSTED_BINDING_ENV_VARS.deadlineAt
  );
  const rawRefs = requireBindingField(env, TRUSTED_BINDING_ENV_VARS.sourceRefs);
  // No default, for the same reason the other seven have none: a grant with an
  // invented consumer would be attached to a stream nobody drains, and its
  // eventual invalidation would be silent. An absent binding is a refusal.
  const consumerId = requireBindingField(
    env,
    TRUSTED_BINDING_ENV_VARS.consumerId
  );

  const sourceRefs = [
    ...new Set(
      rawRefs
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref !== "")
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (sourceRefs.length === 0) {
    throw new StructuredScopeError(
      "invalid_input",
      `${TRUSTED_BINDING_ENV_VARS.sourceRefs} is set but names no source ` +
        "reference. An identity with an empty authorized set is refused, not " +
        "widened to every source."
    );
  }
  if (!Number.isFinite(Date.parse(deadlineAt))) {
    throw new StructuredScopeError(
      "invalid_input",
      `${TRUSTED_BINDING_ENV_VARS.deadlineAt} must be an ISO instant`
    );
  }

  return {
    actorId,
    ownerScopeBinding,
    readerBinding,
    sourceRefs,
    authorizationRevision,
    deadlineAt,
    consumerId,
  };
}

function requireBindingField(env: TrustedBindingEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new StructuredScopeError(
      "access_denied",
      `the trusted identity binding is incomplete: ${name} is ` +
        `${value === undefined ? "absent" : "blank"}. Every allowlisted name ` +
        "must be injected explicitly; an absent field is not defaulted."
    );
  }
  return value.trim();
}

/**
 * Resolve the binding into the one kind of value that carries authority.
 *
 * The mint happens inside `scope.createAuthorizedContext`, so the context is
 * registered in that seam's module-private `WeakMap` and nothing else can be
 * accepted as it later. A caller that assembles an equal-looking object by hand
 * is refused by `scopeAuthorityOf` with `access_denied`, which is why this
 * function returns the seam's own product and never a copy of it.
 */
export function resolveEvidenceScopeContext(
  scope: AuthorizedScopeUnitOfWork,
  env: TrustedBindingEnv
): AuthorizedScopeContext {
  const binding = readTrustedIdentityBinding(env);
  const input: AuthorizedScopeContextInput = {
    actorId: binding.actorId,
    ownerScopeBinding: binding.ownerScopeBinding,
    readerBinding: binding.readerBinding,
    authorizedSourceRefs: binding.sourceRefs,
    authorizationRevision: binding.authorizationRevision,
    deadlineAt: binding.deadlineAt,
  };
  return scope.createAuthorizedContext(input);
}

/**
 * The refusal vocabulary this module can produce, narrowed from the codes it
 * actually throws. Declared so a caller can check that the channel widens no
 * set: both entries are members of `STRUCTURED_SCOPE_FAILURE_CODES` as declared
 * in `structured-scope-types.ts`, and this file never adds to it.
 */
export const TRUSTED_BINDING_FAILURE_CODES = [
  "access_denied",
  "invalid_input",
] as const satisfies readonly (typeof STRUCTURED_SCOPE_FAILURE_CODES)[number][];

/** Whether a code really is a member of the closed scope set. */
export function isScopeFailureCode(
  code: unknown
): code is (typeof STRUCTURED_SCOPE_FAILURE_CODES)[number] {
  return (
    typeof code === "string" &&
    (STRUCTURED_SCOPE_FAILURE_CODES as readonly string[]).includes(code)
  );
}
