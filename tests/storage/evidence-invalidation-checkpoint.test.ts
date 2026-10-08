/**
 * The invalidation checkpoint codec, with no database in the way.
 *
 * Companion to `tests/acceptance/structured-invalidation-drain-pg.test.ts`: that
 * file proves the drain against real rows, and everything HERE is a property of
 * the token itself — that a position cannot be edited into a checkpoint, that a
 * checkpoint minted for one stream is unusable by another, and that a token
 * carrying an unknown field is refused rather than decoded as far as it happens
 * to agree. Those are reachable with a key and no server, which is exactly why
 * they are not left to the real-PostgreSQL lane.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decodeInvalidationCheckpoint,
  INVALIDATION_CHECKPOINT_VERSION,
  invalidationConsumerDigest,
  mintInvalidationCheckpoint,
  requireInvalidationCheckpointKey,
  type InvalidationCheckpointKey,
} from "../../src/core/storage/evidence-invalidation-checkpoint.js";
import { canonicalJson } from "../../src/core/storage/evidence-source.js";

const KEY: InvalidationCheckpointKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8"
);
const OTHER_KEY: InvalidationCheckpointKey = Buffer.from(
  "ffffffffffffffffffffffffffffffff",
  "utf8"
);
const CONSUMER = "fin-consumer";

describe("the invalidation checkpoint", () => {
  it("refuses a key too short to authenticate anything", () => {
    expect(() => requireInvalidationCheckpointKey(Buffer.alloc(0))).toThrowError(
      /at least 32 bytes/
    );
    expect(() => requireInvalidationCheckpointKey(Buffer.alloc(31))).toThrowError(
      /at least 32 bytes/
    );
    // The zero-length key HMACs perfectly well and is reproducible by anyone,
    // which is the exact failure the signature exists to prevent.
    expect(() => requireInvalidationCheckpointKey(Buffer.alloc(32))).not.toThrow();
  });

  it("round-trips a position for the consumer that asked for it", () => {
    for (const seq of [0, 1, 20, 9_007_199_254_740_991]) {
      const token = mintInvalidationCheckpoint(seq, CONSUMER, KEY);
      expect(decodeInvalidationCheckpoint(token, CONSUMER, KEY)).toEqual({
        v: INVALIDATION_CHECKPOINT_VERSION,
        c: invalidationConsumerDigest(CONSUMER),
        s: seq,
      });
    }
  });

  it("never carries the consumer id on the wire (ADR 0097 §2.1)", () => {
    const token = mintInvalidationCheckpoint(7, CONSUMER, KEY);
    const body = Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString(
      "utf8"
    );
    expect(body).not.toContain(CONSUMER);
    expect(JSON.parse(body)).toEqual({
      c: invalidationConsumerDigest(CONSUMER),
      s: 7,
      v: INVALIDATION_CHECKPOINT_VERSION,
    });
  });

  it("refuses a checkpoint minted under another key", () => {
    const token = mintInvalidationCheckpoint(3, CONSUMER, OTHER_KEY);
    expect(decodeInvalidationCheckpoint(token, CONSUMER, KEY)).toBeNull();
  });

  it("refuses a checkpoint presented by another consumer", () => {
    const token = mintInvalidationCheckpoint(3, CONSUMER, KEY);
    expect(decodeInvalidationCheckpoint(token, "someone-else", KEY)).toBeNull();
  });

  it("refuses a rewritten position rather than serving it", () => {
    // The failure this signature exists to prevent: a caller decodes its own
    // checkpoint, raises `s`, and resumes past events it never received. The MAC
    // covers `s`, so re-encoding the body while keeping the original signature
    // is a refusal — and this is the edit an attacker has, not the key.
    const token = mintInvalidationCheckpoint(3, CONSUMER, KEY);
    const separator = token.indexOf(".");
    const originalBody = token.slice(0, separator);
    const originalMac = token.slice(separator + 1);
    const digest = invalidationConsumerDigest(CONSUMER);
    const forgedBody = Buffer.from(
      canonicalJson({
        v: INVALIDATION_CHECKPOINT_VERSION,
        c: digest,
        s: 9999,
      }),
      "utf8"
    ).toString("base64url");
    expect(forgedBody).not.toBe(originalBody);
    expect(decodeInvalidationCheckpoint(`${forgedBody}.${originalMac}`, CONSUMER, KEY)).toBeNull();
    // And the honest control: re-signing the forged body IS accepted, which is
    // what makes the refusal above about the signature rather than about the
    // decoder rejecting every token it did not mint in this process.
    const forgedMac = createHmac("sha256", KEY)
      .update(forgedBody, "utf8")
      .digest("base64url");
    expect(
      decodeInvalidationCheckpoint(`${forgedBody}.${forgedMac}`, CONSUMER, KEY)?.s
    ).toBe(9999);
  });

  it("refuses text that is not a token at all", () => {
    for (const raw of [
      "",
      "no-dot",
      "a.b.c",
      `${mintInvalidationCheckpoint(1, CONSUMER, KEY)}x`,
      "!!!.!!!",
    ]) {
      expect(decodeInvalidationCheckpoint(raw, CONSUMER, KEY)).toBeNull();
    }
  });

  it("refuses a payload carrying an unknown or missing field", () => {
    // Exact key-set match, not membership: an extra field is a token this build
    // never issued, and tolerating it would make the dialect open-ended.
    const sign = (payload: unknown): string => {
      const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `${body}.${createHmac("sha256", KEY).update(body, "utf8").digest("base64url")}`;
    };
    const digest = invalidationConsumerDigest(CONSUMER);
    expect(
      decodeInvalidationCheckpoint(
        sign({ v: INVALIDATION_CHECKPOINT_VERSION, c: digest, s: 1, extra: "x" }),
        CONSUMER,
        KEY
      )
    ).toBeNull();
    expect(
      decodeInvalidationCheckpoint(
        sign({ v: INVALIDATION_CHECKPOINT_VERSION, c: digest }),
        CONSUMER,
        KEY
      )
    ).toBeNull();
    expect(
      decodeInvalidationCheckpoint(sign({ v: "ic2", c: digest, s: 1 }), CONSUMER, KEY)
    ).toBeNull();
    expect(
      decodeInvalidationCheckpoint(
        sign({ v: INVALIDATION_CHECKPOINT_VERSION, c: digest, s: -1 }),
        CONSUMER,
        KEY
      )
    ).toBeNull();
    expect(
      decodeInvalidationCheckpoint(
        sign({ v: INVALIDATION_CHECKPOINT_VERSION, c: digest, s: 1.5 }),
        CONSUMER,
        KEY
      )
    ).toBeNull();
    expect(
      decodeInvalidationCheckpoint(
        sign([1, 2, 3]),
        CONSUMER,
        KEY
      )
    ).toBeNull();
  });

  it("refuses to mint over a position that is not a whole seq", () => {
    expect(() => mintInvalidationCheckpoint(-1, CONSUMER, KEY)).toThrowError(
      /whole seq/
    );
    expect(() => mintInvalidationCheckpoint(1.5, CONSUMER, KEY)).toThrowError(
      /whole seq/
    );
  });
});