/**
 * Entity-type normalization for the closed bootstrap DDL set.
 *
 * `entities.type` is pinned by a CHECK constraint to exactly
 *   ('person','concept','system','event')
 * (src/core/storage/schema-bootstrap.ts §createEntities). The LLM open-string world
 * produces arbitrary-capitalized types ("Organization", "Location", ...). If
 * a raw `headType` / `tailType` were written verbatim into `entities.type`,
 * the CHECK would reject the whole chunk transaction → write-failure → exit 2
 * (CR High #2 finding).
 *
 * This module maps any LLM-emitted type into the closed set at the persist
 * boundary so the pipeline only persists CHECK-safe values. The mapping is
 * a conservative, defensible default that operators can tune later.
 *
 * Mapping (case-insensitive — input is lowercased + trimmed first):
 *   person    ← person, human, individual, user, agent
 *   concept   ← organization, company, team, group, org, concept
 *   system    ← system, tool, platform, service, location, place,
 *               system_component
 *   event     ← event, incident, occurrence, action
 *   concept   ← any other / empty / unknown (fallback, logged at info)
 *
 * `organization` is intentionally mapped to `concept` (the catch-all family);
 * `location`/`place` to `system` because the bootstrap schema does not model
 * geographic entities and the four-type set is the contract.
 */
import { createLogger, type Logger } from "../../logging.js";

export const ENTITY_TYPES = ["person", "concept", "system", "event"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const PERSON = new Set(["person", "human", "individual", "user", "agent"]);
const SYSTEM = new Set([
  "system",
  "tool",
  "platform",
  "service",
  "location",
  "place",
  "system_component",
]);
const EVENT = new Set(["event", "incident", "occurrence", "action"]);
const CONCEPT = new Set(["organization", "company", "team", "group", "org"]);

function defaultLogger(): Logger {
  return createLogger("info");
}

/**
 * Map an LLM-emitted `headType` / `tailType` into the closed bootstrap entity-type
 * set. Pure (only depends on `log` for the unknown→concept fallback). Logs
 * a structured `info` entry whenever an unknown type is folded to `concept`
 * so operators can audit the mapping and tune it.
 */
export function normalizeEntityType(
  rawType: string,
  log: Logger = defaultLogger()
): EntityType {
  const t = rawType.trim().toLowerCase();
  if (PERSON.has(t)) return "person";
  if (SYSTEM.has(t)) return "system";
  if (EVENT.has(t)) return "event";
  if (CONCEPT.has(t) || t === "concept") return "concept";
  log.info("normalize-entity-type-fallback", {
    rawType,
    mappedTo: "concept",
  });
  return "concept";
}
