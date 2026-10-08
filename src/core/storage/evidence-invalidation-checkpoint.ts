/**
 * The invalidation checkpoint: the opaque, server-minted position a consumer
 * resumes its drain from (ADR 0097 §2.3; the spec at
 * `specs/structured-corpus-evidence.md:226`).
 *
 * A codec sibling of `structured-query-cursor.ts` rather than part of that one:
 * the two cursors bind different things — that one binds a QUERY, a SCOPE and a
 * read revision so a page can be continued inside a frozen result set, this one
 * binds a CONSUMER and a position in one per-consumer stream — and sharing the
 * file would make one dialect's key set the other's. What is inherited is the
 * discipline rather than the payload, unchanged: base64url over canonical JSON,
 * an exact key-set match, no partial decode, and a payload that is authenticated
 * rather than merely encoded.
 *
 * **Why the signature is the load-bearing half.** `s` is a CLAIM about how far a
 * consumer has processed, and it is the one field nothing else re-derives: the
 * events themselves carry no assertion that they are contiguous from where this
 * consumer started. Without a MAC, a caller who decodes a checkpoint and rewrites
 * `s` passes every remaining check and silently resumes past events it never
 * received — an empty-looking batch with a hole in it, which is precisely the
 * outcome ADR 0097 §2.7's `gap` rule exists to make impossible to hide. Signing
 * turns "this build minted this, at this position" into a checkable fact.
 *
 * **Why `c` is a digest and not the consumer id.** ADR 0097 §2.1 is explicit that
 * `consumer_id` "identifies the stream, not the event, so it is stored and not
 * sent". Hashing it keeps the same cross-consumer refusal — a checkpoint minted
 * for another stream decodes with a `c` this consumer cannot match — without
 * putting the label on the wire, and it keeps the payload's field width
 * independent of `MAX_CONSUMER_ID_CHARS`.
 *
 * **Why no expiry is carried.** A checkpoint is not a lifetime: the stream's
 * retention is the spec's own rule (an unacknowledged event is kept while its
 * grant is unexpired), and a cursor that expired would make a slow consumer lose
 * events it never scrubbed. There is nothing to renew and nothing to bound.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./evidence-source.js";

/** The checkpoint dialect this build mints. A different value is not this checkpoint. */
export const INVALIDATION_CHECKPOINT_VERSION = "ic1";

/**
 * What one issued checkpoint carries. Every field is verified before it is
 * believed, and `s` is applied only after the signature has been checked.
 */
export interface InvalidationCheckpointPayload {
  /** Checkpoint dialect. */
  readonly v: string;
  /** SHA-256 digest of the owning consumer id, hex. Names the stream, never the actor. */
  readonly c: string;
  /** The highest `seq` this checkpoint covers; the drain resumes strictly above it. */
  readonly s: number;
}

/**
 * The exact key set a checkpoint may carry, in the SORTED order `canonicalJson`
 * emits. Comparing against this list rather than checking membership is what
 * makes a token with an extra or missing field a refusal instead of a decode that
 * quietly tolerates an unknown key.
 */
const PAYLOAD_KEYS = ["c", "s", "v"] as const;

/**
 * The key that authenticates a checkpoint.
 *
 * INJECTED, never defaulted: a deployment that cannot authenticate its own
 * checkpoints cannot tell a resumed drain from a forged position, and a default
 * key is a key every deployment shares, which is the same as no key.
 */
export type InvalidationCheckpointKey = Buffer;

const MINIMUM_CHECKPOINT_KEY_BYTES = 32;

/**
 * Refuse a key too short to authenticate anything, before a reader exists.
 *
 * A zero-length key HMACs perfectly well and is trivially reproducible by anyone,
 * which is the exact failure the signature exists to prevent — so it is rejected
 * at the composition boundary rather than discovered in production.
 */
export function requireInvalidationCheckpointKey(
  key: InvalidationCheckpointKey
): InvalidationCheckpointKey {
  if (!Buffer.isBuffer(key) || key.length < MINIMUM_CHECKPOINT_KEY_BYTES) {
    throw new Error(
      `an invalidation checkpoint key needs at least ` +
        `${MINIMUM_CHECKPOINT_KEY_BYTES} bytes`
    );
  }
  return key;
}

/** The stream identity a checkpoint binds, reduced to a fixed-width digest. */
export function invalidationConsumerDigest(consumerId: string): string {
  return createHash("sha256").update(consumerId, "utf8").digest("hex");
}

/**
 * Mint the checkpoint covering everything through `coveredSeq`.
 *
 * `coveredSeq` is 0 for a stream nothing has been acknowledged against, which is
 * the position a first drain resumes from. It is a position and not an event
 * count: the two diverge the moment the stream is retained, and only the
 * position survives that.
 */
export function mintInvalidationCheckpoint(
  coveredSeq: number,
  consumerId: string,
  key: InvalidationCheckpointKey
): string {
  if (!Number.isSafeInteger(coveredSeq) || coveredSeq < 0) {
    throw new Error(
      `an invalidation checkpoint covers a whole seq, got ${coveredSeq}`
    );
  }
  const payload: InvalidationCheckpointPayload = {
    v: INVALIDATION_CHECKPOINT_VERSION,
    c: invalidationConsumerDigest(consumerId),
    s: coveredSeq,
  };
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  return `${body}.${checkpointMac(body, key)}`;
}

function checkpointMac(body: string, key: InvalidationCheckpointKey): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

/**
 * Decode one checkpoint, or refuse it whole.
 *
 * A value that is not base64url text, not canonical JSON, not a record, not a
 * record with EXACTLY this checkpoint's keys, not signed by this deployment's
 * key, or not carrying a whole non-negative `seq`, is `null`. There is no partial
 * decode and no "recovered" field, because a checkpoint whose half was
 * understood is a position this build never issued.
 *
 * `consumerId` is compared here rather than at the call site so that "was issued
 * for this stream" is one decision in one place: a token minted for another
 * consumer is as unusable as a forged one, and ADR 0097 §2.7 counts both as the
 * backend's `gap` verdict rather than as a crash.
 */
export function decodeInvalidationCheckpoint(
  raw: string,
  consumerId: string,
  key: InvalidationCheckpointKey
): InvalidationCheckpointPayload | null {
  const parts = splitToken(raw);
  if (parts === null) return null;
  if (!signatureMatches(parts.body, parts.mac, key)) return null;
  const record = parseBody(parts.body);
  if (record === null) return null;
  return checkedPayload(record, consumerId);
}

/** The two halves of a token, or `null` when the text is not one at all. */
function splitToken(raw: string): { body: string; mac: string } | null {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  const separator = raw.indexOf(".");
  return {
    body: raw.slice(0, separator),
    mac: raw.slice(separator + 1),
  };
}

/** Constant-time: a MAC that can be probed byte by byte is not a signature. */
function signatureMatches(
  body: string,
  mac: string,
  key: InvalidationCheckpointKey
): boolean {
  const expected = Buffer.from(checkpointMac(body, key), "utf8");
  const offered = Buffer.from(mac, "utf8");
  if (expected.length !== offered.length) return false;
  return timingSafeEqual(expected, offered);
}

/** The body as a record, or `null` when it is not canonical JSON over an object. */
function parseBody(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * The payload's own rules, applied to a body whose signature already checked out.
 *
 * `c` is compared here rather than at the call site so that "was issued for this
 * stream" is one decision in one place: a token minted for another consumer is
 * as unusable as a forged one, and ADR 0097 §2.7 counts both as the backend's
 * `gap` verdict rather than as a crash.
 */
function checkedPayload(
  record: Record<string, unknown>,
  consumerId: string
): InvalidationCheckpointPayload | null {
  const keys = Object.keys(record).sort();
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== PAYLOAD_KEYS[index])
  ) {
    return null;
  }
  if (typeof record.v !== "string" || typeof record.c !== "string") return null;
  if (record.v !== INVALIDATION_CHECKPOINT_VERSION) return null;
  if (record.c !== invalidationConsumerDigest(consumerId)) return null;
  const covered = record.s;
  // `Number.isSafeInteger` rather than a range test: the stream position is an
  // int8 in SQL and a `seq` this large cannot come from a real allocation, so a
  // non-integer here is a forged token, not a deep stream.
  if (typeof covered !== "number" || !Number.isSafeInteger(covered) || covered < 0) {
    return null;
  }
  return { v: record.v, c: record.c, s: covered };
}