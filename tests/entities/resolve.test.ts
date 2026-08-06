import { describe, it, expect } from "vitest";
import {
  resolveCanonicalId,
  type Queryable,
} from "../../src/core/entities/resolve.js";
import { DEFAULT_MERGE_CONFIG } from "../../src/core/entities/types.js";

interface FakeRows {
  rows: Array<{ merged_into: string | null }>;
}

interface FakeClient {
  client: Queryable;
  calls: Array<{ text: string; values: unknown[] }>;
}

function makeFakeClient(
  table: Record<string, { merged_into: string | null }>
): FakeClient {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    client: {
      async query(text: string, values: unknown[]): Promise<FakeRows> {
        calls.push({ text, values });
        const id = values[0] as string;
        const row = table[id];
        if (!row) return { rows: [] };
        return { rows: [row] };
      },
    },
  };
}

describe("resolveCanonicalId", () => {
  it("returns the id unchanged when the entity has no merged_into", async () => {
    const f = makeFakeClient({ a: { merged_into: null } });
    const result = await resolveCanonicalId(f.client, "a");
    expect(result).toBe("a");
    expect(f.calls.length).toBe(1);
  });

  it("walks a linear chain and returns the root id", async () => {
    // a is root, b → a, c → b.
    const f = makeFakeClient({
      a: { merged_into: null },
      b: { merged_into: "a" },
      c: { merged_into: "b" },
    });
    const result = await resolveCanonicalId(f.client, "c");
    expect(result).toBe("a");
  });

  it("returns the input id gracefully on a 2-node cycle and terminates within maxChainDepth+1 queries", async () => {
    const f = makeFakeClient({
      a: { merged_into: "b" },
      b: { merged_into: "a" },
    });
    const cfg = { ...DEFAULT_MERGE_CONFIG, maxChainDepth: 16 };
    const result = await resolveCanonicalId(f.client, "a", cfg);
    // Graceful: return the input id (task: "Cycle → returns A").
    expect(result).toBe("a");
    // Bounded: never more than maxChainDepth+1 queries.
    expect(f.calls.length).toBeLessThanOrEqual(cfg.maxChainDepth + 1);
  });

  it("returns the entity at maxChainDepth when a chain exceeds the depth limit", async () => {
    // 20-node chain: n0 → n1 → n2 → ... → n19 → null.
    const table: Record<string, { merged_into: string | null }> = {};
    for (let i = 0; i < 20; i += 1) {
      table[`n${i}`] = { merged_into: i === 19 ? null : `n${i + 1}` };
    }
    const f = makeFakeClient(table);
    const result = await resolveCanonicalId(f.client, "n0", {
      ...DEFAULT_MERGE_CONFIG,
      maxChainDepth: 5,
    });
    // Five hops from n0 lands at n5.
    expect(result).toBe("n5");
    expect(f.calls.length).toBe(5);
  });
});
