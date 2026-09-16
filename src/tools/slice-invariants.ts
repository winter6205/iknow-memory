/**
 * The fin freeze invariant, walked once for every consumer.
 *
 * Both write tools (`ingest`, `push`) hand a pre-cut `chunks[]` list to
 * storage and neither may re-chunk it (ADR-0004). The slice contract is
 * therefore the same in both: each chunk content is a contiguous substring of
 * the body, in order, with dense 0..N-1 indexes, and a one-slice list
 * requires the slice to equal the body.
 *
 * Both tools enforce it twice — at the Zod boundary (`superRefine`, so the
 * caller gets every violation at once) and again in the handler (defense in
 * depth: a regression that loosens the schema must still be caught). This
 * module is the single walk all four enforcement points consume, so the two
 * layers cannot come to disagree about what the invariant is.
 *
 * Each consumer picks its own reporter, and that choice is the ONLY thing
 * that differs between them: the schema accumulates every issue via
 * `ctx.addIssue`, the handler raises on the first with a tool-name prefix.
 */
import type { z } from "zod";

/** One breach of the freeze invariant, with the path to report it at. */
export interface SliceInvariantViolation {
  path: Array<string | number>;
  message: string;
}

/** The slice shape both tools' schemas produce (`index`, not `ordinal`). */
export interface SliceLike {
  content: string;
  index: number;
}

/**
 * Walk the invariant and return every breach.
 *
 * The dense-index loop reports EVERY non-dense position, but the substring
 * scan stops at the first break — a later slice's position is meaningless
 * once the cursor is wrong.
 */
export function findSliceInvariantViolations(
  body: string,
  slices: ReadonlyArray<SliceLike>
): SliceInvariantViolation[] {
  const violations: SliceInvariantViolation[] = [];
  for (let i = 0; i < slices.length; i += 1) {
    if (slices[i]!.index !== i) {
      violations.push({
        path: ["chunks", i, "index"],
        message: `chunks[].index must be dense 0..${slices.length - 1} (got ${slices[i]!.index} at position ${i})`,
      });
    }
  }
  let cursor = 0;
  for (const slice of slices) {
    const at = body.indexOf(slice.content, cursor);
    if (at === -1) {
      violations.push({
        path: ["chunks", slice.index],
        message: `chunks[${slice.index}] is not a contiguous substring of content`,
      });
      break;
    }
    cursor = at + slice.content.length;
  }
  if (slices.length === 1 && slices[0]!.content !== body) {
    violations.push({
      path: ["chunks"],
      message: "one-slice envelope requires chunk content to equal body",
    });
  }
  return violations;
}

/**
 * Schema-boundary enforcement of the freeze invariant. This is the Zod
 * `superRefine` body both tools attach to their envelope shapes.
 *
 * An absent `chunks` list (legacy one-slice item) is not refined here; the
 * handler normalizes it to a single slice.
 */
export function refineSliceInvariants(
  input: { content: string; chunks?: SliceLike[] | undefined },
  ctx: z.RefinementCtx
): void {
  const chunks = input.chunks;
  if (chunks === undefined) return;
  for (const violation of findSliceInvariantViolations(input.content, chunks)) {
    ctx.addIssue({
      code: "custom",
      path: violation.path,
      message: violation.message,
    });
  }
}
