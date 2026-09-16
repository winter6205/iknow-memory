/** Folded from prototype Variant D: two 冷墨 inks, not one hue per type. */

export const INK_ACTOR = {
  border: "rgba(255, 230, 203, 0.55)",
  background: "rgba(255, 230, 203, 0.16)",
};

export const INK_ARTIFACT = {
  border: "rgba(232, 228, 217, 0.22)",
  background: "rgba(232, 228, 217, 0.05)",
};

const ACTOR_TYPES = new Set(["person", "company"]);

export function inkForType(type: string | undefined) {
  return type !== undefined && ACTOR_TYPES.has(type) ? INK_ACTOR : INK_ARTIFACT;
}
