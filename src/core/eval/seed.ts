/**
 * Load the frozen seed corpus into a storage backend
 * (specs/retrieve-p5.md A8).
 *
 * The eval scores against this corpus and nothing else. Pointing the
 * harness at whatever happens to be in an operator's live store would
 * produce a number that cannot be compared with the previous run, which
 * is the one thing a baseline exists to allow.
 *
 * Embedding goes through the injected `EmbeddingClient`, so the same
 * corpus yields deterministic vectors under `FakeEmbedder` (SC6) and real
 * ones when an operator has an embedding endpoint configured.
 */
import type { EmbeddingClient } from "../embedder.js";
import type { ChunkRecord, StorageBackend } from "../types.js";
import type { EvalCorpus } from "./corpus.js";
import { EvalRunError } from "./errors.js";

/**
 * Embed every corpus chunk and upsert it. Returns how many chunks were
 * stored.
 *
 * `created_at` is set from the chunk's own `valid_from` rather than from
 * the clock: nothing reads it here, and a wall-clock value would make the
 * seeded state differ between runs for no reason.
 */
export async function seedCorpus(
  corpus: EvalCorpus,
  embedder: EmbeddingClient,
  storage: StorageBackend
): Promise<number> {
  const contents = corpus.chunks.map((chunk) => chunk.content);
  const embeddings = await embedder.embed(contents);
  if (embeddings.length !== contents.length) {
    throw new EvalRunError(
      `embedder returned ${embeddings.length} vectors for ${contents.length} corpus chunks; the eval corpus cannot be seeded`
    );
  }

  const records: ChunkRecord[] = corpus.chunks.map((chunk, i) => {
    const embedding = embeddings[i];
    if (embedding === undefined || embedding.length === 0) {
      throw new EvalRunError(
        `embedder returned no usable vector for eval corpus chunk "${chunk.id}"`
      );
    }
    return {
      id: chunk.id,
      content: chunk.content,
      embedding,
      source_ref: chunk.source_ref,
      metadata: chunk.metadata,
      valid_from: chunk.valid_from,
      valid_until: chunk.valid_until,
      created_at: chunk.valid_from,
    };
  });

  const ids = await storage.upsert(records);
  return ids.length;
}
