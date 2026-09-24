/**
 * Read source tool — MCP name `read_source`.
 *
 * Reads one stored 资料 (source_documents) row, addressed by its `source_ref`
 * locator **xor** its primary-key `id`, and hands back ONE bounded slice of
 * the body plus a cursor — never the whole body. The stored row stays the
 * authoritative full text; this tool never writes, invalidates, or touches
 * derived chunks. Deps are the StorageReadPort only.
 *
 * Wire contract:
 *  - Input `{ source_ref | id, position? }`. `position` is a zero-based
 *    code-point offset (default 0) checked in the handler, not the schema: a
 *    schema-level `.int()` / `.min()` would let the SDK answer an
 *    out-of-domain position with prose instead of this tool's structured
 *    error body.
 *  - Success: `textResult(JSON.stringify({ id, source_ref, title?, content,
 *    next_position }))`. `content` is the contiguous slice
 *    `[position, position + taken)`; `next_position` is the offset the host
 *    must pass next, or `null` once the body is exhausted. `title` is omitted
 *    when the row has none. `position` is never echoed back.
 *  - Ceilings, enforced before the result leaves this function: at most
 *    `SOURCE_READ_MAX_TEXT_CODE_POINTS` code points of text and at most
 *    `SOURCE_READ_MAX_RESULT_BYTES` UTF-8 bytes for the complete serialized
 *    ToolResult — measured on the emitted payload, so the terminal `null`
 *    cursor is certified, not just the numeric one. Every legal cursor
 *    advances, so a host resumes rather than repeats.
 *  - Typed errors (all isError): `read_source_not_found`,
 *    `read_source_invalidated`, `read_source_invalid_position`,
 *    `read_source_invalid_locator`, `read_source_unavailable`. Every error
 *    body is subject to the same byte ceiling, so an unbounded stored
 *    `source_ref` is dropped (with `source_ref_omitted: true`) rather than
 *    overflow the wire. `read_source_invalid_locator` carries a `reason`
 *    (`request_locator_oversized`, `resolved_identity_oversized`, or
 *    `non_advancing_slice`); its and `unavailable`'s bodies never echo the
 *    request's `source_ref` — that value is what broke the budget — and the
 *    `unavailable` message is redacted.
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
import type { StorageReadPort, StorageSourceDocView } from "../core/types.js";
import { GraphragError } from "../core/errors.js";
import { redactDiagnostic } from "../logging.js";

/** Hard ceiling on the text a single successful slice may carry. */
export const SOURCE_READ_MAX_TEXT_CODE_POINTS = 8_000;
/** Hard ceiling on the serialized ToolResult that leaves this function. */
export const SOURCE_READ_MAX_RESULT_BYTES = 32_768;
/** Ceiling on the request locator; beyond it the identity itself is uncarryable. */
export const SOURCE_READ_MAX_LOCATOR_CODE_POINTS = 1_024;

export const ReadSourceInputSchema = z
  .strictObject({
    source_ref: z
      .string()
      .min(1, "source_ref must be a non-empty string")
      .optional(),
    id: z.string().uuid("id must be a UUID").optional(),
    // No `.int()` / `.min(0)` / `.max()` by design: range and size rejections
    // must come back as this tool's structured error body.
    position: z.number().optional(),
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
    assertExclusiveSelector(input);

    const position = input.position ?? 0;
    if (!Number.isInteger(position) || position < 0) {
      // EXIT: position outside its domain → typed read_source_invalid_position
      // carrying the rejected value; the row has not been read yet.
      return errorResult({ error: "read_source_invalid_position", position });
    }

    const locatorFault = oversizedLocator(input.source_ref);
    if (locatorFault !== undefined) {
      return locatorFault;
    }

    const loaded = await loadSourceDoc(deps.storage, input);
    if ("result" in loaded) {
      return loaded.result;
    }
    return readBoundedSlice(loaded.doc, position);
  };
}

export const readSourceTool = (deps: ReadSourceDeps): ToolRegistration => ({
  name: "read_source",
  description:
    "Read a stored 资料 by its source_ref locator or by its primary-key id. " +
    "Bounded and resumable: each call returns ONE contiguous slice of at most " +
    SOURCE_READ_MAX_TEXT_CODE_POINTS +
    " Unicode code points, and the whole serialized result never exceeds " +
    SOURCE_READ_MAX_RESULT_BYTES +
    " UTF-8 bytes. Pass the returned next_position back in as `position` " +
    "to continue; next_position is null once the body is exhausted. The " +
    "authoritative full body stays in storage. Pure read: no embedding, no " +
    "ranking. A missing key returns a named read_source_not_found error " +
    "result; an invalidated 资料 returns a named read_source_invalidated " +
    "error result. Neither is an empty success.",
  inputSchema: ReadSourceInputSchema,
  handler: createReadSourceHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});

/** Row identity echoed on every success payload. */
interface SourceIdentity {
  readonly id: string;
  readonly source_ref: string;
  readonly title?: string;
}

interface SourceSlicePayload extends SourceIdentity {
  readonly content: string;
  readonly next_position: number | null;
}

/** Everything the slice search needs, kept in one small read-only record. */
interface SliceContext {
  readonly identity: SourceIdentity;
  readonly codePoints: readonly string[];
  readonly position: number;
  readonly total: number;
  readonly cap: number;
}

function assertExclusiveSelector(input: ReadSourceInput): void {
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
}

function oversizedLocator(
  sourceRef: string | undefined
): ToolResult | undefined {
  if (sourceRef === undefined) {
    return undefined;
  }
  if (Array.from(sourceRef).length <= SOURCE_READ_MAX_LOCATOR_CODE_POINTS) {
    return undefined;
  }
  // EXIT: oversized locator → typed read_source_invalid_locator before any
  // storage touch; the offending value is not echoed, it is the overflow.
  return invalidLocator(
    "request_locator_oversized",
    `source_ref exceeds ${SOURCE_READ_MAX_LOCATOR_CODE_POINTS} code points`
  );
}

type LoadedDoc =
  { readonly doc: StorageSourceDocView } | { readonly result: ToolResult };

async function loadSourceDoc(
  storage: StorageReadPort,
  input: ReadSourceInput
): Promise<LoadedDoc> {
  const sourceRef = input.source_ref;
  const id = input.id;
  let read;
  try {
    read =
      sourceRef !== undefined
        ? await storage.getSourceDoc(sourceRef)
        : await storage.getSourceDocById(id!);
  } catch (err) {
    // EXIT: storage fault → typed read_source_unavailable. The message is
    // redacted so a connection string can never reach the wire.
    return {
      result: errorResult({
        error: "read_source_unavailable",
        message: redactDiagnostic(err),
      }),
    };
  }

  if (!read.ok) {
    // EXIT: named not-found — the host must distinguish "no such 资料" from
    // a success with an empty body.
    return {
      result: errorResult({
        error: "read_source_not_found",
        ...(sourceRef !== undefined ? { source_ref: sourceRef } : { id: id }),
      }),
    };
  }

  const doc = read.value;
  if (doc.valid_until !== null && doc.valid_until !== undefined) {
    // EXIT: closed validity window → named invalidation carrying the ROW's
    // identity, so the body is never returned as if still authoritative.
    return {
      result: errorResult({
        error: "read_source_invalidated",
        id: doc.id,
        source_ref: doc.source_ref,
        valid_until: doc.valid_until,
      }),
    };
  }
  return { doc };
}

function readBoundedSlice(
  doc: StorageSourceDocView,
  position: number
): ToolResult {
  // Array.from iterates code points, so a surrogate pair is one unit and a
  // slice boundary can never split it.
  const codePoints = Array.from(doc.content);
  const total = codePoints.length;
  if (position > total) {
    // EXIT: cursor past the end → typed read_source_invalid_position with the
    // row's length; position === total is the legal empty terminal slice.
    return errorResult({
      error: "read_source_invalid_position",
      position,
      code_points: total,
    });
  }

  const ctx: SliceContext = {
    identity: sliceIdentity(doc),
    codePoints,
    position,
    total,
    cap: Math.min(total - position, SOURCE_READ_MAX_TEXT_CODE_POINTS),
  };

  // Measure against the terminal (null) cursor form: identity plus the
  // shortest possible slice must fit before anything is emitted.
  if (resultBytes(buildPayload(ctx, 0)) > SOURCE_READ_MAX_RESULT_BYTES) {
    // EXIT: the resolved identity alone will not fit the byte budget →
    // typed read_source_invalid_locator; no slice is emitted.
    return invalidLocator(
      "resolved_identity_oversized",
      "resolved identity exceeds the result byte budget"
    );
  }

  // The binary search certifies the NUMERIC cursor form because it is the
  // monotone one. The emitted terminal form substitutes `null`, which is
  // longer than a cursor below 1,000, so re-measure the exact object that
  // leaves this function and shrink until it fits.
  let taken = selectTaken(ctx);
  while (resultBytes(buildPayload(ctx, taken)) > SOURCE_READ_MAX_RESULT_BYTES) {
    taken -= 1;
  }
  if (taken === 0 && ctx.cap > 0) {
    // EXIT: a successful slice that does not advance would loop the host →
    // typed read_source_invalid_locator rather than a non-progressing cursor.
    return invalidLocator(
      "non_advancing_slice",
      "no advancing slice fits the result byte budget"
    );
  }
  return textResult(JSON.stringify(buildPayload(ctx, taken)));
}

/**
 * Largest `taken` in [0, cap] whose serialized result fits the byte budget.
 *
 * Every candidate is measured with `next_position` as the NUMBER
 * `position + taken`, never `null`: digits(x) is non-decreasing in x while
 * `null` is a fixed 4 characters, so mixing the two forms makes the predicate
 * non-monotone and a binary search could then report an oversized maximum.
 */
function selectTaken(ctx: SliceContext): number {
  if (candidateFits(ctx, ctx.cap)) {
    return ctx.cap;
  }
  // cap does not fit and 0 does (a non-terminal taken=0 measures identically
  // to the caller's terminal-form precheck), so the answer is the boundary of
  // a monotone predicate — ~13 measurements, not a per-code loop.
  let low = 0;
  let high = ctx.cap;
  while (high - low > 1) {
    const mid = low + Math.ceil((high - low) / 2);
    if (candidateFits(ctx, mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

function candidateFits(ctx: SliceContext, taken: number): boolean {
  return (
    resultBytes(candidatePayload(ctx, taken)) <= SOURCE_READ_MAX_RESULT_BYTES
  );
}

/** The object `textResult()` returns is what crosses the wire, so the
 *  JSON-in-JSON envelope counts in the measurement. */
function resultBytes(payload: SourceSlicePayload): number {
  return envelopeBytes(JSON.stringify(payload));
}

function candidatePayload(
  ctx: SliceContext,
  taken: number
): SourceSlicePayload {
  return {
    ...ctx.identity,
    content: sliceText(ctx, taken),
    next_position: ctx.position + taken,
  };
}

/** The exact payload that leaves `readBoundedSlice`, measured and emitted
 *  through this one builder so the byte ceiling is certified on the form the
 *  host actually receives — including the terminal `null` cursor. */
function buildPayload(ctx: SliceContext, taken: number): SourceSlicePayload {
  const end = ctx.position + taken;
  return {
    ...ctx.identity,
    content: sliceText(ctx, taken),
    next_position: end >= ctx.total ? null : end,
  };
}

function sliceText(ctx: SliceContext, taken: number): string {
  return ctx.codePoints.slice(ctx.position, ctx.position + taken).join("");
}

function sliceIdentity(doc: StorageSourceDocView): SourceIdentity {
  return {
    id: doc.id,
    source_ref: doc.source_ref,
    ...(doc.title !== null ? { title: doc.title } : {}),
  };
}

function invalidLocator(reason: string, message: string): ToolResult {
  return errorResult({
    error: "read_source_invalid_locator",
    reason,
    message,
  });
}

/**
 * Every result that leaves this tool — success or error — is a complete
 * serialized MCP tool result subject to the 32 KiB ceiling. Error bodies
 * carry no content, but a stored locator is unbounded text: if echoing it
 * would overflow the budget, drop it and name that the host must resume by
 * `id`. `id` (a uuid) plus the fixed fields always fit.
 */
function errorResult(body: Readonly<Record<string, unknown>>): ToolResult {
  const json = JSON.stringify(body);
  if (
    "source_ref" in body &&
    envelopeBytes(json) > SOURCE_READ_MAX_RESULT_BYTES
  ) {
    const withoutLocator: Record<string, unknown> = {
      ...body,
      source_ref_omitted: true,
    };
    delete withoutLocator.source_ref;
    return textResult(JSON.stringify(withoutLocator), true);
  }
  return textResult(json, true);
}

/** Bytes of the complete serialized ToolResult for a body already JSON'd. */
function envelopeBytes(bodyJson: string): number {
  return Buffer.byteLength(JSON.stringify(textResult(bodyJson, true)), "utf8");
}
