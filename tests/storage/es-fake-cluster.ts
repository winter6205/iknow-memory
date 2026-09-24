/**
 * A minimal in-memory Elasticsearch stand-in for precision-layer unit tests.
 *
 * It materialises indices, bulk documents, and ALIASES, so a test can ask the
 * only question that matters for a derived index: which documents does a reader
 * aimed at the configured index name actually see right now.
 */
import type { ElasticsearchClientLike } from "../../src/core/storage/elasticsearch-precision.js";

interface FakeIndex {
  docs: Map<string, Record<string, unknown>>;
}

type DocEntry = [id: string, source: Record<string, unknown>];

function notFoundError(message: string): Error {
  return Object.assign(new Error(message), { meta: { statusCode: 404 } });
}

export class FakeEsCluster {
  private readonly indices = new Map<string, FakeIndex>();
  private readonly aliases = new Map<string, string>();

  /** When set, the bulk with this ordinal (1-based across all writes) rejects. */
  failNthBulk?: number;

  /** When set, the next alias update rejects once. */
  failNextAliasUpdate = false;

  private bulkCount = 0;

  /** Community ids currently readable through the given index name or alias. */
  liveCommunityIds(name: string): string[] {
    return this.entries(name)
      .map(([, doc]) => String(doc.community_id))
      .sort();
  }

  indexNames(): string[] {
    return [...this.indices.keys()].sort();
  }

  /** Physical indices other than the one `name` resolves to (staging residue). */
  orphanIndices(name: string): string[] {
    const live = this.aliases.get(name) ?? name;
    return this.indexNames().filter((index) => index !== live);
  }

  client(): ElasticsearchClientLike {
    return {
      indices: {
        exists: async (request) => {
          const name = String(request.index);
          return this.indices.has(name) || this.aliases.has(name);
        },
        create: async (request) => {
          const name = String(request.index);
          if (this.indices.has(name) || this.aliases.has(name)) {
            throw new Error(`resource_already_exists_exception: [${name}]`);
          }
          this.indices.set(name, { docs: new Map() });
          return { acknowledged: true };
        },
        delete: async (request) => {
          const name = String(request.index);
          if (!this.indices.has(name)) throw notFoundError(`no such index: ${name}`);
          this.indices.delete(name);
          for (const [alias, concrete] of this.aliases) {
            if (concrete === name) this.aliases.delete(alias);
          }
          return { acknowledged: true };
        },
        analyze: async () => ({ tokens: [] }),
        getAlias: async (request) => {
          const name = String(request.name);
          const concrete = this.aliases.get(name);
          if (concrete === undefined) throw notFoundError(`no such alias: ${name}`);
          return { [concrete]: { aliases: { [name]: {} } } };
        },
        updateAliases: async (request) => {
          if (this.failNextAliasUpdate) {
            this.failNextAliasUpdate = false;
            throw new Error("cluster down: alias update rejected");
          }
          this.applyAliasActions(request.actions);
          return { acknowledged: true };
        },
      },
      bulk: async (request) => {
        const name = String(request.index);
        const operations = (request.operations ?? []) as unknown[];
        const index = this.require(name);
        this.bulkCount += 1;
        if (this.failNthBulk === this.bulkCount) {
          throw new Error("cluster down: bulk rejected");
        }
        this.writeDocuments(index, operations);
        return { errors: false, items: [] };
      },
      search: async (request) => ({
        hits: {
          hits: this.entries(String(request.index)).map(([id, source]) => ({
            _id: id,
            _score: 1,
            _source: source,
          })),
        },
      }),
      deleteByQuery: async (request) => {
        this.require(String(request.index));
        return { deleted: 0 };
      },
      close: async () => {},
    };
  }

  private applyAliasActions(actions: unknown): void {
    const next = new Map(this.aliases);
    for (const action of (actions ?? []) as Array<Record<string, unknown>>) {
      this.applyAliasAction(next, action);
    }
    this.aliases.clear();
    for (const [alias, index] of next) this.aliases.set(alias, index);
  }

  /**
   * Actions are applied in body order against a working copy, exactly as the
   * real cluster resolves one atomic `_aliases` transaction: a `remove` frees
   * the alias for the `add` that follows it in the same call.
   */
  private applyAliasAction(
    next: Map<string, string>,
    action: Record<string, unknown>
  ): void {
    const removeIndex = action.remove_index as { index?: unknown } | undefined;
    if (removeIndex !== undefined) {
      this.dropIndex(next, String(removeIndex.index));
      return;
    }
    const remove = action.remove as
      | { index?: unknown; alias?: unknown }
      | undefined;
    if (remove !== undefined) {
      this.dropAlias(next, String(remove.index), String(remove.alias));
    }
    const add = action.add as { index?: unknown; alias?: unknown } | undefined;
    if (add !== undefined) {
      this.bindAlias(next, String(add.alias), String(add.index));
    }
  }

  /**
   * A `remove` names the index it takes the alias off, so a request aimed at a
   * slot the alias does not resolve to is an error: freeing the live binding
   * instead would let the `add` that follows it in the same body publish over a
   * generation the caller never saw. `*` is the documented "every index
   * currently bound to this alias" form.
   */
  private dropAlias(
    next: Map<string, string>,
    index: string,
    alias: string
  ): void {
    const bound = next.get(alias);
    if (bound === undefined) throw new Error(`alias_missing: [${alias}]`);
    if (index !== "*" && index !== bound) {
      throw new Error(
        `invalid_aliases: [${alias}] is not bound to [${index}]`
      );
    }
    next.delete(alias);
  }

  private bindAlias(
    next: Map<string, string>,
    alias: string,
    index: string
  ): void {
    if (!this.indices.has(index)) {
      throw new Error(`invalid_aliases: no such index [${index}]`);
    }
    const bound = next.get(alias);
    if (bound !== undefined && bound !== index) {
      throw new Error(`alias_conflict: [${alias}] is already in use`);
    }
    next.set(alias, index);
  }

  private dropIndex(next: Map<string, string>, name: string): void {
    this.indices.delete(name);
    for (const [alias, concrete] of next) {
      if (concrete === name) next.delete(alias);
    }
  }

  private writeDocuments(index: FakeIndex, operations: unknown[]): void {
    for (let offset = 0; offset + 1 < operations.length; offset += 2) {
      const spec = operations[offset] as { index?: { _id?: unknown } };
      const source = operations[offset + 1] as Record<string, unknown>;
      index.docs.set(String(spec.index?._id), source);
    }
  }

  private require(name: string): FakeIndex {
    const index = this.indices.get(name);
    if (index === undefined) {
      throw new Error(`index_not_found_exception: no such index [${name}]`);
    }
    return index;
  }

  private entries(name: string): DocEntry[] {
    const concrete = this.aliases.get(name) ?? name;
    return [...(this.indices.get(concrete)?.docs ?? [])];
  }
}
