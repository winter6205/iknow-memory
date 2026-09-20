/**
 * Entity-type normalization for the closed bootstrap DDL set.
 *
 * `entities.type` is pinned by a CHECK constraint to exactly
 *   ('person','organization','place','event')
 * (src/core/storage/schema-bootstrap.ts §createEntities). The LLM open-string world
 * produces arbitrary-capitalized types ("Organization", "Location", ...). If
 * a raw `headType` / `tailType` were written verbatim into `entities.type`,
 * the CHECK would reject the whole chunk transaction → write-failure → exit 2
 * (CR High #2 finding).
 *
 * This module maps any LLM-emitted type into the closed set at the persist
 * boundary. Types outside the set return `null` — there is deliberately no
 * catch-all bucket (spec entity-type-and-filter: unknown proposed types are
 * NOT written as entities). The persist layer turns a null into a typed skip
 * and owns the operator-facing log; this mapper stays pure.
 *
 * Mapping (case-insensitive — input is lowercased + trimmed first):
 *   person       ← person, human, individual, user, agent
 *   organization ← organization, company, org, team
 *   place        ← place, location, geo
 *   event        ← event, incident, occurrence, action
 *   null         ← anything else, including the legacy 'concept'/'system'
 */

export const ENTITY_TYPES = ["person", "organization", "place", "event"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const PERSON = new Set(["person", "human", "individual", "user", "agent"]);
const ORGANIZATION = new Set(["organization", "company", "org", "team"]);
const PLACE = new Set(["place", "location", "geo"]);
const EVENT = new Set(["event", "incident", "occurrence", "action"]);

/**
 * Map an LLM-emitted `headType` / `tailType` into the closed bootstrap
 * entity-type set; `null` signals an unknown type the caller must not
 * persist (typed skip, never a fallback row).
 */
export function normalizeEntityType(rawType: string): EntityType | null {
  const t = rawType.trim().toLowerCase();
  if (PERSON.has(t)) return "person";
  if (ORGANIZATION.has(t)) return "organization";
  if (PLACE.has(t)) return "place";
  if (EVENT.has(t)) return "event";
  return null;
}
