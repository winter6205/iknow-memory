/** MemoryBackend against the shared structured-publication contract. */
import { describe, expect, it } from "vitest";

import type { StructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import type { MaintenanceWorkStore } from "../../src/core/maintenance/types.js";
import type {
  PublicationOutboxPort,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { ChunkRecord } from "../../src/core/types.js";
import {
  createPublicationTestClock,
  describeContract,
  type PublicationTestPort,
} from "./publication-contract.js";

const DIMENSIONS = 8;
const NOW = new Date();

interface IntegratedMemoryBackend extends MemoryBackend {
  structuredPublication?: StructuredPublicationStorage;
  /** The exact registry composed into structuredPublication's unit of work. */
  structuredIdentityStore?: StructuredIdentityStore;
  /** The exact ledger composed into structuredPublication's unit of work. */
  maintenanceWorkStore?: MaintenanceWorkStore;
}

function createPublicationOutbox(): PublicationOutboxPort & {
  failNextWrite(): void;
  delayNextWrite(milliseconds: number): void;
  count(scopeBinding: string): number;
} {
  const committed = new Map<string, number>();
  let failNext = false;
  let delayMilliseconds = 0;

  return {
    failNextWrite() {
      failNext = true;
    },
    delayNextWrite(milliseconds) {
      delayMilliseconds = milliseconds;
    },
    count(scopeBinding) {
      return committed.get(scopeBinding) ?? 0;
    },
    async prepareIntents(scopeBinding, subjects) {
      const delay = delayMilliseconds;
      delayMilliseconds = 0;
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      if (failNext) {
        failNext = false;
        throw new Error("injected publication outbox preparation failure");
      }
      const intentCount = subjects.length;
      return () => {
        committed.set(
          scopeBinding,
          (committed.get(scopeBinding) ?? 0) + intentCount
        );
      };
    },
  };
}

async function openMemoryPort(): Promise<PublicationTestPort> {
  const outbox = createPublicationOutbox();
  const backend = new MemoryBackend(DIMENSIONS, {
    publicationOutbox: outbox,
  }) as IntegratedMemoryBackend;
  const publication = backend.structuredPublication;
  const identity = backend.structuredIdentityStore;
  const work = backend.maintenanceWorkStore;
  if (!publication || !identity || !work) {
    throw new Error(
      "MemoryBackend must expose the integrated publication, identity, and work stores"
    );
  }

  return {
    publication,
    evidence: backend,
    identity,
    work,
    clock: createPublicationTestClock(NOW),
    async seedGraphEntities(entityIds) {
      const chunks: ChunkRecord[] = entityIds.map((id) => ({
        id,
        content: `publication test entity ${id}`,
        embedding: new Array<number>(DIMENSIONS).fill(0),
        source_ref: "structured-publication-test-fixture",
        metadata: {},
        valid_from: NOW.toISOString(),
        valid_until: null,
        created_at: NOW.toISOString(),
      }));
      if (chunks.length > 0) await backend.upsert(chunks);
    },
    async failNextOutboxWrite() {
      outbox.failNextWrite();
    },
    async delayNextOutboxWrite(milliseconds) {
      outbox.delayNextWrite(milliseconds);
    },
    async readOutboxCount(scopeBinding) {
      return outbox.count(scopeBinding);
    },
    close: () => backend.close(),
  };
}

describe("MemoryBackend structured publication wiring", () => {
  it("exposes the optional publication capability without making it a required backend method", () => {
    const backend = new MemoryBackend(DIMENSIONS) as IntegratedMemoryBackend;
    expect(backend.structuredPublication).toBeDefined();
    expect(typeof backend.structuredPublication?.declareDesired).toBe(
      "function"
    );
    expect(typeof backend.structuredPublication?.stageAttempt).toBe("function");
    expect(typeof backend.structuredPublication?.publish).toBe("function");
    expect(typeof backend.structuredPublication?.withdraw).toBe("function");
    expect(typeof backend.structuredPublication?.readSnapshot).toBe("function");
  });
});

describeContract("MemoryBackend", openMemoryPort);
