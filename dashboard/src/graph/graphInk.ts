/** Folded from prototype Variant D: two 冷墨 inks, not one hue per type.
 * The closed entity type set (person|organization|place|event) splits into
 * actor inks (person/organization) and artifact inks (place/event).
 * entity-type-and-filter review C2: the schema bootstrap hard-deletes every
 * non-closed-set row and the CHECK rejects new ones, so a historical value
 * (concept/system) can no longer reach the display layer — there is no third
 * "historical" ink. `inkForType`'s fallback is defensive only: an unknown
 * value reuses the quieter artifact default without adding a display
 * concept. */

export const INK_ACTOR = {
  border: "rgba(255, 230, 203, 0.55)",
  background: "rgba(255, 230, 203, 0.16)",
};

export const INK_ARTIFACT = {
  border: "rgba(232, 228, 217, 0.22)",
  background: "rgba(232, 228, 217, 0.05)",
};

const ACTOR_TYPES = new Set(["person", "organization"]);

export function inkForType(type: string | undefined) {
  if (type !== undefined && ACTOR_TYPES.has(type)) return INK_ACTOR;
  // place/event land here by definition; any other value is defensively
  // folded into the same quieter ink (see module comment).
  return INK_ARTIFACT;
}
