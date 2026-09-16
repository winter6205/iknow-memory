/**
 * Read source tool — MCP name `read_source` (operator-console T4,
 * specs/operator-console.md §MCP tools).
 *
 * Returns the full 资料 (source_documents) body that T3's write envelope
 * stored, addressed by its `source_ref` locator **xor** its primary-key
 * `id`. This is a pure READ tool: no embedder, no batch limit, no
 * precision layer — deps are the StorageReadPort only.
 *
 * Wire contract:
 *  - Success: `textResult(JSON.stringify({ id, source_ref, title?, content }))`.
 *    `title` is omitted when the row has none (spec says `title?`).
 *  - Miss: a *named* not-found — `textResult(JSON.stringify({
 *    error: "read_source_not_found", ... }), true)`. Never a bare `""`
 *    success content block (the fin host treats isError / the named code
 *    as the read miss).
 *  - Invalidated 资料 (operator-console T5): a distinct named-invalid —
 *    `{"error": "read_source_invalidated", "valid_until": <instant>, ...}`
 *    with isError. The row exists (SELECT-able) but its window is closed,
 *    so the body is not returned as if still authoritative.
 *  - Both keys given, or neither: typed validation error (INVALID_INPUT),
 *    mirrored at handler level so direct (non-wire) callers get the same
 *    rejection as the zod schema produces.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { StorageReadPort } from "../core/types.js";
import { GraphragError } from "../core/errors.js";

export const ReadSourceInputSchema = z
  .strictObject({
    source_ref: z
      .string()
      .min(1, "source_ref must be a non-empty string")
      .optional(),
    id: z.string().uuid("id must be a UUID").optional(),
  })
  .superRefine((input, ctx) => {
    const hasRef = input.source_ref !== undefined;
    const hasId = input.id !== undefined;
    if (hasRef && hasId) {
      ctx.addIssue({
        code: "custom",
        path: ["source_ref"],
        message: "provide exactly one key: source_ref or id, never both",
      });
      return;
    }
    if (!hasRef && !hasId) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "provide exactly one key: source_ref or id",
      });
    }
  });

export type ReadSourceInput = z.infer<typeof ReadSourceInputSchema>;

/** Dependencies injected at wiring time — the read port only. */
export interface ReadSourceDeps {
  storage: StorageReadPort;
}

export function createReadSourceHandler(deps: ReadSourceDeps) {
  return async function readSourceHandler(
    input: ReadSourceInput
  ): Promise<ToolResult> {
    // Defensive re-check for direct (non-wire) callers; the zod schema
    // enforces the same xor rule upstream on the MCP path.
    const hasRef = input?.source_ref !== undefined;
    const hasId = input?.id !== undefined;
    if (hasRef === hasId) {
      throw new GraphragError(
        "read_source: provide exactly one key: source_ref or id, never both (or neither)",
        "INVALID_INPUT"
      );
    }

    const sourceRef = input.source_ref;
    const id = input.id;
    const read =
      sourceRef !== undefined
        ? await deps.storage.getSourceDoc(sourceRef)
        : await deps.storage.getSourceDocById(id!);

    if (!read.ok) {
      // Named not-found: the host must be able to distinguish "no such
      // 资料" from a success with an empty body — spec: miss is named,
      // not `""`, not a 200-empty.
      return textResult(
        JSON.stringify({
          error: "read_source_not_found",
          ...(sourceRef !== undefined ? { source_ref: sourceRef } : { id: id }),
        }),
        true
      );
    }

    const doc = read.value;
    if (doc.valid_until !== null && doc.valid_until !== undefined) {
      // Operator-console T5: an INVALIDATED 资料 is a distinct named miss —
      // the row exists but content invalidation has closed its window, so
      // the body must not be handed back as if still authoritative. The
      // host can tell this apart from read_source_not_found and from a
      // success. valid_until carries back the close instant, plus the
      // resolved row identity (doc.id / doc.source_ref) so the host can
      // map a request back to the underlying 资料 regardless of which
      // key the caller used.
      return textResult(
        JSON.stringify({
          error: "read_source_invalidated",
          id: doc.id,
          source_ref: doc.source_ref,
          valid_until: doc.valid_until,
        }),
        true
      );
    }
    return textResult(
      JSON.stringify({
        id: doc.id,
        source_ref: doc.source_ref,
        ...(doc.title !== null ? { title: doc.title } : {}),
        content: doc.content,
      })
    );
  };
}

export const readSourceTool = (deps: ReadSourceDeps): ToolRegistration => ({
  name: "read_source",
  description:
    "Fetch the full body of a stored 资料 by its source_ref locator or by " +
    "its primary-key id. Pure read: no embedding, no ranking. A missing " +
    "key returns a named read_source_not_found error result; an " +
    "invalidated 资料 returns a named read_source_invalidated error " +
    "result. Neither is an empty success.",
  inputSchema: ReadSourceInputSchema,
  handler: createReadSourceHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});
