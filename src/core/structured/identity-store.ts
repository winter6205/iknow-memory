/**
 * Persistent structured-result identity storage (structured corpus query, Q-ID).
 *
 * A dedicated store rather than a `StorageBackend` method: the structured query
 * feature has its own result-identity lifecycle (one id per exact tuple, stable
 * across rebuilds, corrected by versioning) and must not be expressed in terms
 * of the existing `StorageBackend` surface, which stays byte-identical here. The
 * Evidence plan's support persistence consumes this registry; nothing in this
 * module depends on that support persistence existing, so the identity milestone
 * never blocks on it.
 *
 * Both implementations share one identity contract, enforced in
 * `identity.ts`:
 *   - an entity's result id is its EXISTING entity UUID (validated, never
 *     minted here);
 *   - a relation assertion's result id is the derivation of its exact normalized
 *     tuple, so registering the same tuple again resolves to the same id and a
 *     changed tuple is a new corrected identity rather than a merge.
 *
 * The Postgres implementation additionally enforces the `entities(id)` foreign
 * key, so an identity can only be registered for an entity that really exists.
 * The in-memory implementation does not: it is a dev/test double and
 * pretending otherwise would let a test pass against behavior the product
 * store does not have.
 */
import type { EntityType } from "../extraction/entity-type.js";
import {
  deriveRelationAssertionId,
  normalizeEntityId,
  normalizeRelationAssertion,
  relationAssertionTupleDigest,
  requireEntityType,
  StructuredIdentityError,
  type NormalizedValidWindow,
  type RelationAssertionInput,
} from "./identity.js";

/** Registered entity result identity. `entityId` is the existing entity UUID. */
export interface RegisteredEntityIdentity {
  readonly entityId: string;
  readonly type: EntityType;
}

/** Raw entity identity input, before canonicalization. */
export interface EntityIdentityInput {
  readonly entityId: string;
  readonly type: string;
}

/** Registered relation-assertion identity plus the tuple it was derived from. */
export interface RegisteredRelationAssertionIdentity {
  readonly assertionId: string;
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly tailEntityId: string;
  readonly validWindow: NormalizedValidWindow;
  readonly tupleDigest: string;
  readonly identityVersion: number;
}

/** Registration + resolution of persistent structured-result identities. */
export interface StructuredIdentityStore {
  registerEntity(input: EntityIdentityInput): Promise<RegisteredEntityIdentity>;
  findEntity(entityId: string): Promise<RegisteredEntityIdentity | null>;
  registerRelationAssertion(
    input: RelationAssertionInput
  ): Promise<RegisteredRelationAssertionIdentity>;
  findRelationAssertion(
    assertionId: string
  ): Promise<RegisteredRelationAssertionIdentity | null>;
}

function toRegistered(
  assertionId: string,
  tuple: ReturnType<typeof normalizeRelationAssertion>
): RegisteredRelationAssertionIdentity {
  return {
    assertionId,
    headEntityId: tuple.headEntityId,
    relationNorm: tuple.relationNorm,
    tailEntityId: tuple.tailEntityId,
    validWindow: tuple.validWindow,
    tupleDigest: relationAssertionTupleDigest(tuple),
    identityVersion: tuple.identityVersion,
  };
}

function collisionRefusal(): never {
  // Reaching this means two DIFFERENT exact tuples derived the same id, which
  // would silently merge two assertions. Refused rather than resolved.
  throw new StructuredIdentityError(
    "structured identity refused relation_assertion: a different exact tuple " +
      "already registered under this derived identity (derivation collision)",
    "relation_assertion"
  );
}

/**
 * Dev/test identity store. Idempotency and the corrected-identity rule are held
 * here in the same shape the Postgres store holds them in SQL, so a test driving
 * this store is testing the contract and not a mock of it.
 */
export class InMemoryStructuredIdentityStore implements StructuredIdentityStore {
  private readonly entities = new Map<string, RegisteredEntityIdentity>();
  private readonly assertions = new Map<string, RegisteredRelationAssertionIdentity>();
  /** `identityVersion:tupleDigest` → assertionId; the exact-tuple key. */
  private readonly byTuple = new Map<string, string>();

  get relationAssertionCount(): number {
    return this.assertions.size;
  }

  async registerEntity(
    input: EntityIdentityInput
  ): Promise<RegisteredEntityIdentity> {
    // A registered entity's type is a display attribute, not part of its
    // identity (the entity UUID is), so re-registering after a legitimate type
    // change refreshes the mirrored value and never the id.
    const entity: RegisteredEntityIdentity = {
      entityId: normalizeEntityId(input.entityId),
      type: requireEntityType(input.type),
    };
    this.entities.set(entity.entityId, entity);
    return entity;
  }

  async findEntity(
    entityId: string
  ): Promise<RegisteredEntityIdentity | null> {
    return this.entities.get(normalizeEntityId(entityId)) ?? null;
  }

  async registerRelationAssertion(
    input: RelationAssertionInput
  ): Promise<RegisteredRelationAssertionIdentity> {
    const tuple = normalizeRelationAssertion(input);
    const assertionId = deriveRelationAssertionId(tuple);
    const digest = relationAssertionTupleDigest(tuple);
    const tupleKey = `${tuple.identityVersion}:${digest}`;
    const registeredId = this.byTuple.get(tupleKey);
    if (registeredId !== undefined) {
      // The same exact tuple registering again. A different assertionId here
      // would mean two tuples share one derivation, which is a collision, not
      // a repeat support.
      if (registeredId !== assertionId) collisionRefusal();
      return this.assertions.get(assertionId)!;
    }
    // Reached with a tuple the digest index has never seen, so an existing row
    // under this id must have come from a DIFFERENT tuple: a derivation
    // collision, refused rather than merged.
    const existing = this.assertions.get(assertionId);
    if (existing !== undefined && existing.tupleDigest !== digest) {
      collisionRefusal();
    }
    const registered = toRegistered(assertionId, tuple);
    this.assertions.set(assertionId, registered);
    this.byTuple.set(tupleKey, assertionId);
    return registered;
  }

  async findRelationAssertion(
    assertionId: string
  ): Promise<RegisteredRelationAssertionIdentity | null> {
    return this.assertions.get(assertionId) ?? null;
  }
}

/**
 * Minimal client surface the Postgres store consumes: a `pg.Pool`,
 * a `pg.PoolClient`, or a leased CLI client all satisfy it structurally.
 */
export interface StructuredIdentityClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

interface StoredAssertionRow {
  assertion_id: string;
  head_entity_id: string;
  relation_norm: string;
  tail_entity_id: string;
  valid_from: string | null;
  valid_until: string | null;
  tuple_digest: string;
  identity_version: number;
}

/** Postgres unique-violation; the constraint that carries exact-tuple equality. */
const TUPLE_UNIQUE_CONSTRAINT = "structured_relation_assertion_identities_tuple_idx";

function toStoredAssertion(row: StoredAssertionRow): RegisteredRelationAssertionIdentity {
  return {
    assertionId: row.assertion_id,
    headEntityId: row.head_entity_id,
    relationNorm: row.relation_norm,
    tailEntityId: row.tail_entity_id,
    validWindow: { from: row.valid_from, until: row.valid_until },
    tupleDigest: row.tuple_digest,
    identityVersion: row.identity_version,
  };
}

/**
 * Postgres identity registry, over the two tables `upSchemaBootstrap` creates.
 *
 * Re-registration is `ON CONFLICT (assertion_id) DO NOTHING` followed by a
 * read-back: because the id is DERIVED from the tuple, a repeat registration is
 * literally the same primary key, so the second support of an assertion cannot
 * create a second row. The UNIQUE `(identity_version, tuple_digest)` index is
 * the independent guard on the exact-tuple rule — a unique violation there means
 * two different tuples reached one id, and is refused rather than resolved.
 *
 * The window columns are `text`, not `timestamptz`, on purpose: the canonical
 * string IS the identity input, and a timestamptz column would re-render through
 * the session TimeZone, so a stored row could no longer be compared
 * byte-for-byte against the serialization its id was derived from.
 */
export class PgStructuredIdentityStore implements StructuredIdentityStore {
  constructor(private readonly client: StructuredIdentityClient) {}

  async registerEntity(
    input: EntityIdentityInput
  ): Promise<RegisteredEntityIdentity> {
    const entityId = normalizeEntityId(input.entityId);
    const type = requireEntityType(input.type);
    // DO UPDATE, not DO NOTHING: the type is an attributed display value, not
    // part of the identity, so refreshing it after a legitimate change is safe
    // and leaves `entity_id` — the identity — untouched.
    const result = await this.client.query(
      `INSERT INTO structured_entity_identities (entity_id, entity_type)
            VALUES ($1, $2)
       ON CONFLICT (entity_id) DO UPDATE
              SET entity_type = EXCLUDED.entity_type
         RETURNING entity_id, entity_type`,
      [entityId, type]
    );
    const row = result.rows[0] as
      | { entity_id: string; entity_type: string }
      | undefined;
    if (row === undefined) {
      throw new StructuredIdentityError(
        "structured identity refused entity: registration returned no row",
        "entity_id"
      );
    }
    return { entityId: row.entity_id, type: requireEntityType(row.entity_type) };
  }

  async findEntity(
    entityId: string
  ): Promise<RegisteredEntityIdentity | null> {
    const result = await this.client.query(
      `SELECT entity_id, entity_type
         FROM structured_entity_identities
        WHERE entity_id = $1`,
      [normalizeEntityId(entityId)]
    );
    const row = result.rows[0] as
      | { entity_id: string; entity_type: string }
      | undefined;
    if (row === undefined) return null;
    return { entityId: row.entity_id, type: requireEntityType(row.entity_type) };
  }

  async registerRelationAssertion(
    input: RelationAssertionInput
  ): Promise<RegisteredRelationAssertionIdentity> {
    const tuple = normalizeRelationAssertion(input);
    const assertionId = deriveRelationAssertionId(tuple);
    const tupleDigest = relationAssertionTupleDigest(tuple);
    try {
      const inserted = await this.client.query(
        `INSERT INTO structured_relation_assertion_identities
           (assertion_id, head_entity_id, relation_norm, tail_entity_id,
            valid_from, valid_until, tuple_digest, identity_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (assertion_id) DO NOTHING
         RETURNING assertion_id`,
        [
          assertionId,
          tuple.headEntityId,
          tuple.relationNorm,
          tuple.tailEntityId,
          tuple.validWindow.from,
          tuple.validWindow.until,
          tupleDigest,
          tuple.identityVersion,
        ]
      );
      if (inserted.rows.length > 0) {
        return toRegistered(assertionId, tuple);
      }
    } catch (err) {
      if (isTupleUniqueViolation(err)) collisionRefusal();
      throw err;
    }
    // Conflict path: the same exact tuple is already registered. Read it back so
    // the caller sees the persisted identity, never a freshly derived one.
    return (await this.findRelationAssertion(assertionId)) ?? collisionRefusal();
  }

  async findRelationAssertion(
    assertionId: string
  ): Promise<RegisteredRelationAssertionIdentity | null> {
    const result = await this.client.query(
      `SELECT assertion_id, head_entity_id, relation_norm, tail_entity_id,
              valid_from, valid_until, tuple_digest, identity_version
         FROM structured_relation_assertion_identities
        WHERE assertion_id = $1`,
      [assertionId]
    );
    const row = result.rows[0] as StoredAssertionRow | undefined;
    return row === undefined ? null : toStoredAssertion(row);
  }
}

function isTupleUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === "23505" && candidate.constraint === TUPLE_UNIQUE_CONSTRAINT
  );
}
