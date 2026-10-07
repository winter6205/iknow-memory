/**
 * In-memory twin of the collector eligibility read.
 *
 * Restart survival is a Postgres property, so this twin cannot answer anything
 * about durability. What it answers is that the same rules hold without a
 * database: which edges are dependencies, which grants protect content, and which
 * leases are still valid. It re-derives facts through the same branches the SQL
 * uses, so the two cannot drift on WHICH fact was gathered — and the boundary
 * comparisons themselves live in `collector-eligibility.ts`, which both call.
 */
import type {
  CollectionCandidate,
  CollectionCountGrant,
  CollectionCurrentDependency,
  CollectionEligibilityReader,
  CollectionLease,
  CollectionReadFacts,
  CollectionRowReference,
} from "../maintenance/collector-types.js";

export interface MemorySourceVersion {
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly sourceVersionId: string;
  readonly retiredAt: string | null;
  readonly payloadCollectedAt: string | null;
}

export interface MemorySupport {
  readonly supportId: string;
  readonly sourceVersionId: string;
}

export interface MemoryGrant {
  readonly evidenceRef: string;
  /** `row` grants protect content; `count` grants protect only their receipt. */
  readonly grantKind: "row" | "count";
  readonly expiresAt: string;
  readonly receiptId?: string | null;
}

export interface MemoryPublicationSource {
  readonly sourceRef: string;
  readonly publishedSourceVersion?: string | null;
  readonly desiredSourceVersion?: string | null;
}

export interface MemoryJob {
  readonly jobKey: string;
  readonly sourceRef: string;
  readonly status: "pending" | "running" | "ready" | "failed" | "stale";
  readonly leaseExpiresAt: string | null;
}

/** Everything the twin holds. A test seeds it; nothing here writes. */
export interface InMemoryCollectionSeed {
  readonly sourceVersions?: readonly MemorySourceVersion[];
  readonly supports?: readonly MemorySupport[];
  /** `(evidence_ref, support_id)` links, in both grant-support tables. */
  readonly grantSupports?: readonly {
    readonly evidenceRef: string;
    readonly supportId: string;
  }[];
  readonly grants?: readonly MemoryGrant[];
  readonly publicationSources?: readonly MemoryPublicationSource[];
  /** Source refs with a staged (not yet published) extraction attempt. */
  readonly stagedSourceRefs?: readonly string[];
  readonly jobs?: readonly MemoryJob[];
}

export class InMemoryCollectionEligibilityReader implements CollectionEligibilityReader {
  private readonly seed: Required<InMemoryCollectionSeed>;

  constructor(seed: InMemoryCollectionSeed = {}) {
    this.seed = {
      sourceVersions: seed.sourceVersions ?? [],
      supports: seed.supports ?? [],
      grantSupports: seed.grantSupports ?? [],
      grants: seed.grants ?? [],
      publicationSources: seed.publicationSources ?? [],
      stagedSourceRefs: seed.stagedSourceRefs ?? [],
      jobs: seed.jobs ?? [],
    };
  }

  async readCollectionFacts(
    candidate: CollectionCandidate,
    _now: Date,
    activeReaders: readonly CollectionLease[] = []
  ): Promise<CollectionReadFacts> {
    const payloadRef = candidate.payloadRef;
    const sourceVersion = candidate.source?.sourceVersion ?? null;
    const target = this.targetOf(payloadRef, sourceVersion);
    const supportIds = this.supportIdsOf(target?.sourceVersionId ?? null);
    const payloadGrants = this.grantsOver(supportIds);

    return {
      bindingResolved: target !== null,
      payloadCollected: target?.payloadCollectedAt != null,
      currentDependencies: this.dependenciesOf(payloadRef, target),
      validLeases: [
        ...this.jobLeasesOf(payloadRef),
        ...activeReaders,
      ],
      rowReferences: payloadGrants
        .filter((grant) => grant.grantKind === "row")
        .map<CollectionRowReference>((grant) => ({
          evidenceRef: grant.evidenceRef,
          expiresAt: grant.expiresAt,
        })),
      countOnlyGrants: payloadGrants
        .filter((grant) => grant.grantKind === "count")
        .map<CollectionCountGrant>((grant) => ({
          evidenceRef: grant.evidenceRef,
          receiptId: grant.receiptId ?? "",
          expiresAt: grant.expiresAt,
        })),
    };
  }

  private targetOf(
    sourceRef: string,
    sourceVersion: string | null
  ): MemorySourceVersion | null {
    if (sourceVersion === null) return null;
    return (
      this.seed.sourceVersions.find(
        (version) =>
          version.sourceRef === sourceRef && version.sourceVersion === sourceVersion
      ) ?? null
    );
  }

  private supportIdsOf(sourceVersionId: string | null): readonly string[] {
    if (sourceVersionId === null) return [];
    return this.seed.supports
      .filter((support) => support.sourceVersionId === sourceVersionId)
      .map((support) => support.supportId);
  }

  /** Grants that reach this payload through a support or a pinned extraction. */
  private grantsOver(supportIds: readonly string[]): readonly MemoryGrant[] {
    if (supportIds.length === 0) return [];
    const held = new Set(
      this.seed.grantSupports
        .filter((link) => supportIds.includes(link.supportId))
        .map((link) => link.evidenceRef)
    );
    return this.seed.grants.filter((grant) => held.has(grant.evidenceRef));
  }

  private dependenciesOf(
    payloadRef: string,
    target: MemorySourceVersion | null
  ): readonly CollectionCurrentDependency[] {
    const found: CollectionCurrentDependency[] = [];
    const currentGeneration = this.seed.sourceVersions.find(
      (version) =>
        version.sourceRef === payloadRef &&
        version.retiredAt === null &&
        version.sourceVersionId !== target?.sourceVersionId
    );
    if (currentGeneration !== undefined) {
      found.push({
        kind: "current_source_version",
        holder: currentGeneration.sourceVersion,
      });
    }
    const published = this.seed.publicationSources.find(
      (publication) =>
        publication.sourceRef === payloadRef &&
        (publication.publishedSourceVersion === target?.sourceVersion ||
          publication.desiredSourceVersion === target?.sourceVersion)
    );
    if (published !== undefined) {
      found.push({ kind: "published_or_desired_scope", holder: payloadRef });
    }
    if (this.seed.stagedSourceRefs.includes(payloadRef)) {
      found.push({ kind: "staged_publication", holder: payloadRef });
    }
    if (
      this.seed.jobs.some(
        (job) =>
          job.sourceRef === payloadRef &&
          (job.status === "pending" || job.status === "running")
      )
    ) {
      found.push({ kind: "live_maintenance_job", holder: payloadRef });
    }
    return found;
  }

  private jobLeasesOf(payloadRef: string): readonly CollectionLease[] {
    return this.seed.jobs
      .filter(
        (job) =>
          job.sourceRef === payloadRef &&
          job.status === "running" &&
          job.leaseExpiresAt !== null
      )
      .map((job) => ({
        kind: "job" as const,
        holder: job.jobKey,
        expiresAt: job.leaseExpiresAt as string,
      }));
  }
}