/**
 * Explicit purge for a structured source (fin
 * `specs/structured-corpus-maintenance.md` §Physical collection, steps 1–4 and
 * the explicit-purge paragraph; register §1.2 and §1b.4; ADR 0097 §4.1/§4.2).
 *
 * **What this module is: one transaction, and nothing else.** An explicit purge
 * writes the tombstone, advances `purge_revision`, cancels affected work and emits
 * the durable fin invalidation events in ONE `COMMIT`. Those four writes are
 * atomic because they share a leased client, not because they share a lock — a
 * lock serializes and cannot make four writes atomic together, and a
 * session-scoped advisory lock would additionally pin a connection for the whole
 * purge.
 *
 * **What this module is NOT.** It deletes no payload (that is MP15) and it records
 * no all-owner completion (that is MP17, gated on the four-state table in the
 * acknowledgement contract). What it DOES carry, since MP17, is the `scheduled`
 * half of that table: `schedulePurgeCompletion` is called here, inside this
 * transaction, because ADR 0099 §2.1 makes `scheduled` true only when the
 * invalidation events are durably queued in the same commit as the tombstone. It
 * writes no `completed_at` — ADR 0099 §2.4a's writer separation means no statement
 * in this file could, and a contract test fails if one appears.
 *
 * **The tombstone comes before the deletion, and the deletion is not here.** The
 * tombstone is committed first because it is what makes a retry safe: a retry
 * finds it, joins it instead of allocating a second `seq`, and therefore cannot
 * punch a gap into the per-consumer stream — the gap fin's contiguity rule
 * refuses. Nothing in this module removes a row of source content, so there is no
 * window in which a deletion could commit ahead of the tombstone.
 *
 * **Cancelling work is a fence write, not an expiry wait.** The worker lease is
 * five minutes; a purge cannot wait it out and must not hold row locks while
 * trying. Clearing `fencing_token` is the same invalidation `reclaimExpiredWork`
 * performs, so the running attempt's next heartbeat and its next settle both
 * report `lease_lost` against a row it can no longer match.
 *
 * **The active-read wait is bounded by the TTL invariant, not by a timer.** Every
 * lease row expires at most `expires_at - acquired_at` after its own acquisition,
 * so polling to zero terminates even if every reader crashed and no reaper ever
 * runs. The wait therefore runs in its own short transactions BEFORE the purge
 * transaction rather than inside it: holding the source and scope rows for up to
 * a minute would queue every publication and ledger write behind a purge.
 *
 * **PostgreSQL only, with no in-memory twin.** A lease is a concurrency primitive
 * whose whole point is visibility across transaction boundaries; a `Map` twin
 * would pass every unit test while proving nothing. `invalidation-outbox.ts` is
 * the existing precedent for a deliberate no-twin module.
 */
import { randomUUID } from "node:crypto";

import { recordSuppressedFailure } from "../errors.js";
import { requirePublicationString } from "../maintenance/publication-service.js";
import { EVIDENCE_GRANT_KIND } from "../types.js";
import { sqlTextLiteral } from "./schema-sql.js";
import { isBoundedConsumerId } from "./evidence-store.js";
import { lockScopeRevisions, writeScopeRevisions } from "./evidence-pg.js";
import {
  allocateInvalidationSeq,
  INVALIDATION_REASON,
} from "./invalidation-outbox.js";
import {
  readConfiguredOwners,
  schedulePurgeCompletion,
} from "./structured-purge-completion.js";
import { scopedSafeNumber } from "./structured-scope-reads.js";
import {
  advanceRevision,
  lockAffectedSources,
  lockOwnerScope,
  reserveSources,
  stableSourceRefs,
} from "./structured-scope-locks-pg.js";
import { PgScopeTransactionRunner } from "./structured-scope-uow.js";
import {
  StructuredScopeError,
  structuredScopeError,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
} from "./structured-scope-types.js";
import type { StructuredReaderKind } from "./schema-structured-purge.js";

/**
 * How short a poll waits when the observed leases have not yet expired.
 *
 * A floor rather than a zero-wait loop: a lease expiring in one millisecond would
 * otherwise spin the connection on a query that cannot yet answer differently.
 */
const LEASE_POLL_FLOOR_MS = 25;

/**
 * The status an affected job is fenced into.
 *
 * `MAINTENANCE_WORK_STATUS` in `core/maintenance/types.ts` is the authority; this
 * literal is asserted against it by
 * `tests/storage/structured-purge-contract.unit.test.ts`, so a vocabulary that
 * drops `stale` fails a test here instead of silently fencing work into a state
 * the worker loop never reads.
 */
export const PURGE_FENCED_WORK_STATUS = "stale";

/** The failure code an open attempt carries when a purge takes its lease away. */
export const PURGE_FENCED_ATTEMPT_FAILURE = "lease_lost";

/** One explicit purge. `purgeRevision` is the caller's idempotency token. */
export interface StructuredPurgeRequest {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  /**
   * The revision to install as the scope's `purge_revision`.
   *
   * Caller-supplied, not minted here, because idempotency is defined by it: a retry
   * presents the same revision and joins the committed tombstone. A value the
   * caller cannot reproduce would make every retry a second purge.
   */
  readonly purgeRevision: string;
}

/** What one purge committed, or that the requested purge was already committed. */
export interface StructuredPurgeOutcome {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly purgeRevision: string;
  /** False when this exact purge had already committed — the idempotent retry. */
  readonly applied: boolean;
  /** The source generation the tombstone left behind. */
  readonly generation: number;
  /** Jobs whose attempt was fenced by this purge. */
  readonly fencedJobKeys: readonly string[];
  /** Grant references this purge published an invalidation event for. */
  readonly invalidatedRefs: readonly string[];
  /**
   * Grant references that name no drainable consumer, so no event could be
   * published for them. Reported rather than swallowed: a reference silently
   * dropped is a snapshot fin is never told to scrub.
   */
  readonly unpublishedRefs: readonly string[];
  /** Live read leases still registered for the source when the purge committed. */
  readonly activeReadLeases: number;
}

/** What a reader registers before it starts reading. */
export interface StructuredReadLeaseBinding {
  readonly scopeBinding: string;
  readonly sourceRefs: readonly string[];
  readonly readerKind: StructuredReaderKind;
  /** The reader's own execution bound; the lease cannot outlive it. */
  readonly ttlMs: number;
}

/** A leased connection. Satisfied by `pg.PoolClient` and by the test fakes. */
export interface StructuredPurgeLease {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** Anything that can lease a connection: `pg.Pool` satisfies this. */
export interface StructuredPurgePool {
  connect(): Promise<StructuredPurgeLease>;
}

/**
 * One refusal rule, reused rather than restated.
 *
 * The publication validator is the maintenance family's existing non-blank rule;
 * a second copy of it is a second rule one of the two will forget. The refusal is
 * re-raised in this module's own vocabulary so the transaction keeps a single
 * closed set of typed failures.
 */
function requireToken(value: unknown, field: string): string {
  try {
    return requirePublicationString(value, field);
  } catch (error) {
    throw new StructuredScopeError(
      "invalid_input",
      error instanceof Error ? error.message : `${field} is required`,
      { cause: error }
    );
  }
}

/**
 * Validate one purge request before anything is written.
 *
 * Exported so the refusal contract is provable without a database: a blank or
 * non-string field must never reach the transaction, because the tombstone write
 * is keyed on exactly these three values.
 */
export function validateStructuredPurgeRequest(
  input: unknown
): StructuredPurgeRequest {
  const request = (input ?? {}) as Partial<StructuredPurgeRequest>;
  return {
    scopeBinding: requireToken(request.scopeBinding, "scopeBinding"),
    sourceRef: requireToken(request.sourceRef, "sourceRef"),
    purgeRevision: requireToken(request.purgeRevision, "purgeRevision"),
  };
}

/** The active-lease scan: how many are live, and how long the last one holds out. */
interface ActiveLeaseWindow {
  readonly active: number;
  readonly waitMs: number;
}

/**
 * The wait, expressed in the database's clock rather than the caller's.
 *
 * `max(expires_at) - now()` is computed by PostgreSQL because the lease row and
 * the scan must agree on "now": a client clock ahead of the server's would report
 * a lease expired while it is still live, and a client clock behind would wait on
 * one that is not.
 */
const ACTIVE_LEASE_SQL = `
  SELECT count(*)::bigint AS active,
         coalesce(
           floor(extract(epoch FROM (max(expires_at) - now())) * 1000)::bigint,
           0) AS wait_ms
    FROM structured_read_leases
   WHERE scope_binding = $1
     AND source_ref = ANY($2::text[])
     AND expires_at > now()`;

function toActiveLeaseWindow(row: Record<string, unknown>): ActiveLeaseWindow {
  return {
    active: scopedSafeNumber(row.active, "active read lease count"),
    waitMs: scopedSafeNumber(row.wait_ms, "read lease wait"),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register one reader's lease, in its own committed transaction.
 *
 * Its own transaction is the whole design: a row written inside the read's own
 * transaction would be invisible to a purge's `SELECT` under MVCC, so the purge
 * would see no reader and remove payloads underneath a live one. Committed here,
 * the row is visible to every other transaction and expires on its own if this
 * reader dies.
 *
 * The `purge_revision` recorded is the one this reader is authorized under, read
 * in the same short transaction, so a lease row names the state its reader was
 * admitted to rather than a second, independently-sourced copy of it.
 */
async function registerReadLease(
  owner: ScopeTransactionOwner,
  binding: StructuredReadLeaseBinding
): Promise<string> {
  const leaseId = randomUUID();
  const sourceRefs = stableSourceRefs([...new Set(binding.sourceRefs)]);
  return owner.runTransaction(
    async (client) => {
      const scope = await client.query(
        `SELECT purge_revision
           FROM evidence_scope_revisions WHERE scope_binding = $1`,
        [binding.scopeBinding]
      );
      const purgeRevision = scope.rows[0]?.purge_revision;
      if (typeof purgeRevision !== "string" || purgeRevision.length === 0) {
        // EXIT: without a recorded purge revision this read is not admitted to
        // anything, so it registers nothing and is refused by its own fence.
        // Refusing here keeps the absence from being an invisible reader.
        throw new StructuredScopeError(
          "access_denied",
          `scope "${binding.scopeBinding}" carries no recorded purge revision, so no read may register against it`
        );
      }
      const { rows } = await client.query(
        `INSERT INTO structured_read_leases
           (lease_id, scope_binding, source_ref, reader_kind, purge_revision,
            acquired_at, expires_at)
         SELECT $1::uuid, $2, ref.source_ref, $3, $4, now(),
                now() + ($5::bigint * interval '1 millisecond')
           FROM unnest($6::text[]) AS ref(source_ref)
         RETURNING lease_id`,
        [
          leaseId,
          binding.scopeBinding,
          binding.readerKind,
          purgeRevision,
          binding.ttlMs,
          sourceRefs,
        ]
      );
      // A short source list would insert fewer rows than it named, and a read
      // that took a lease without a row is exactly the invisible reader the
      // design exists to prevent.
      if (rows.length !== sourceRefs.length) {
        throw new StructuredScopeError(
          "backend_unavailable",
          `read lease registered ${rows.length} of ${sourceRefs.length} sources`
        );
      }
      return leaseId;
    },
    { fail: structuredScopeError }
  );
}

/**
 * Drop the lease once the read has answered.
 *
 * `DELETE … RETURNING` and the row count deliberately NOT asserted. An absent row
 * is the normal shape of a second release, and of a reader whose row was already
 * gone; treating that as a failure would fail a read that has already produced its
 * answer over a lease nobody is waiting on any more.
 *
 * A release that fails is folded into the read's own outcome rather than
 * replacing it: the read's typed refusal is what the caller branches on, and a
 * lease row that outlives its reader costs one purge at most one lease period.
 */
async function releaseReadLease(
  owner: ScopeTransactionOwner,
  leaseId: string,
  outcome: { readonly value: unknown } | { readonly failure: unknown }
): Promise<void> {
  try {
    await owner.runTransaction(
      (client) => client.query(
        "DELETE FROM structured_read_leases WHERE lease_id = $1::uuid RETURNING lease_id",
        [leaseId]
      ),
      { fail: structuredScopeError }
    );
  } catch (error) {
    if ("failure" in outcome) {
      recordSuppressedFailure(outcome.failure, error);
      return;
    }
    throw error;
  }
}

/**
 * The one entry a read path uses to take and give back its lease.
 *
 * Acquisition and row insertion are inseparable here, which is the point: a read
 * path that could take a lease and skip the row would leave a purge waiting on a
 * reader it cannot see, and no bound on that lease could ever be reached.
 */
export async function withStructuredReadLease<R>(
  owner: ScopeTransactionOwner,
  binding: StructuredReadLeaseBinding,
  body: () => Promise<R>
): Promise<R> {
  const leaseId = await registerReadLease(owner, binding);
  let outcome: { readonly value: R } | { readonly failure: unknown };
  try {
    outcome = { value: await body() };
  } catch (failure) {
    outcome = { failure };
  }
  await releaseReadLease(owner, leaseId, outcome);
  if ("failure" in outcome) throw outcome.failure;
  return outcome.value;
}

/**
 * One grant a purge invalidates, and the stream its event belongs to.
 */
interface AffectedGrant {
  readonly evidenceRef: string;
  readonly consumerId: string;
}

export class PgStructuredPurgeStore {
  private readonly scope: ScopeTransactionOwner;

  constructor(
    private readonly pool: StructuredPurgePool,
    scope?: ScopeTransactionOwner
  ) {
    this.scope = scope ?? new PgScopeTransactionRunner(() => this.lease());
  }

  /**
   * Purge one source: deny its reads, cancel its work, announce it to fin.
   *
   * The active-read wait happens first and in its own transactions. A reader that
   * is still running when the tombstone commits is refused at grant issuance by
   * the fence that already exists, and the physical removal re-runs this same
   * wait, so nothing is deleted under a live reader — but the wait cannot happen
   * inside this transaction without holding the source and scope rows for a
   * minute.
   */
  async purge(
    input: StructuredPurgeRequest
  ): Promise<StructuredPurgeOutcome> {
    const request = validateStructuredPurgeRequest(input);
    await this.awaitActiveReads({
      scopeBinding: request.scopeBinding,
      sourceRefs: [request.sourceRef],
    });
    return this.transact((client) => this.applyPurge(client, request));
  }

  /**
   * Wait until no live read lease covers these sources, and report how many it
   * found.
   *
   * Termination is the TTL invariant, not a deadline: each iteration sleeps until
   * the latest observed expiry, so a crashed reader's row stops holding the wait
   * on its own even though nothing reaps it. A reader that arrives mid-wait is
   * waited for too, which is why the loop re-scans rather than returning on the
   * first empty read.
   */
  async awaitActiveReads(input: {
    readonly scopeBinding: string;
    readonly sourceRefs: readonly string[];
  }): Promise<number> {
    const scopeBinding = requireToken(input?.scopeBinding, "scopeBinding");
    const sourceRefs = stableSourceRefs([
      ...new Set(input?.sourceRefs ?? []),
    ]);
    if (sourceRefs.length === 0) return 0;
    const lease = await this.lease();
    let observed = 0;
    try {
      for (;;) {
        const { rows } = await lease.query(ACTIVE_LEASE_SQL, [
          scopeBinding,
          sourceRefs,
        ]);
        const window = toActiveLeaseWindow(rows[0] ?? {});
        if (window.active === 0) return observed;
        observed = window.active;
        await delay(Math.max(LEASE_POLL_FLOOR_MS, window.waitMs + 1));
      }
    } finally {
      lease.release();
    }
  }

  /**
   * One client, one transaction, one commit — the discipline
   * `PgScopeTransactionRunner` already owns, so the purge does not open a second
   * transaction vocabulary.
   */
  private transact<T>(
    body: (client: ScopeTransactionClient) => Promise<T>
  ): Promise<T> {
    return this.scope.runTransaction(body, { fail: structuredScopeError });
  }

  private async applyPurge(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<StructuredPurgeOutcome> {
    // The shared lock order: source reservations, then the owner scope, then the
    // affected source rows. Reserving first is what makes the scope row's owner
    // stable while this transaction holds it.
    await reserveSources(client, [request.sourceRef]);
    await lockOwnerScope(client, request.scopeBinding);
    const [source] = await lockAffectedSources(
      client,
      request.scopeBinding,
      [request.sourceRef]
    );
    // The admission row the read side's fence compares against. Taken after the
    // publication locks and never before, because nothing in the shared order
    // takes it earlier; a grant issuance only READS it, and a read does not block
    // on — nor is blocked by — a `FOR UPDATE` it did not ask for.
    const admission = await lockScopeRevisions(client, request.scopeBinding);
    if (admission === null) {
      // EXIT: without a recorded purge revision nothing would be denied, so the
      // tombstone would be a marker no reader could ever be refused by.
      throw new StructuredScopeError(
        "access_denied",
        `scope "${request.scopeBinding}" has no recorded purge revision, so a purge cannot deny its grants`
      );
    }
    const committed = await this.readTombstone(client, request);
    if (committed !== null) {
      return this.replayedOutcome(request, source.generation);
    }
    await this.writeTombstone(client, request);
    const generation = await this.tombstoneSource(client, request);
    await writeScopeRevisions(
      client,
      request.scopeBinding,
      null,
      request.purgeRevision
    );
    const fencedJobKeys = await this.fenceAffectedWork(client, request);
    const grants = await this.readAffectedGrants(client, request);
    const published = await this.emitInvalidations(client, grants);
    // ADR 0099 §2.1's `scheduled`, in THIS commit rather than beside it: the state
    // is true only when the invalidation events are durably queued, so seeding it
    // after this transaction would leave a window where a tombstone exists with no
    // record of what it announced. The owner set is read here, inside the purge,
    // and the owner rows carry the allocation watermark reached AFTER emission —
    // which is the position an acknowledgement must reach for this revision to read
    // as scrubbed for that owner.
    await schedulePurgeCompletion(client, {
      scopeBinding: request.scopeBinding,
      purgeRevision: request.purgeRevision,
      consumerIds: await readConfiguredOwners(client, request.scopeBinding),
    });
    // The purge changes what a reader may see AND what a worker may report, so
    // both revisions move — once, here, after every fallible step.
    await advanceRevision(client, request.scopeBinding, {
      read: true,
      maintenance: true,
    });
    return {
      scopeBinding: request.scopeBinding,
      sourceRef: request.sourceRef,
      purgeRevision: request.purgeRevision,
      applied: true,
      generation,
      fencedJobKeys,
      invalidatedRefs: published.invalidated,
      unpublishedRefs: published.unpublished,
      activeReadLeases: await this.readActiveLeaseCount(client, request),
    };
  }

  /**
   * What a retry of an already-committed purge reports.
   *
   * No second revision advance, no second fence and no second event: the whole
   * point of reading the tombstone before allocating a `seq` is that a retry is
   * indistinguishable from the first call's result rather than an extra purge.
   */
  private replayedOutcome(
    request: StructuredPurgeRequest,
    generation: number
  ): StructuredPurgeOutcome {
    return {
      scopeBinding: request.scopeBinding,
      sourceRef: request.sourceRef,
      purgeRevision: request.purgeRevision,
      applied: false,
      generation: scopedSafeNumber(generation, "source generation"),
      fencedJobKeys: [],
      invalidatedRefs: [],
      unpublishedRefs: [],
      activeReadLeases: 0,
    };
  }

  /**
   * The tombstone, read under the scope lock the purge already holds.
   *
   * `purge_revision` is part of the key rather than a column read back, so the
   * answer to "did this purge already commit" cannot depend on a row whose
   * revision was later superseded by another purge.
   */
  private async readTombstone(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<{ readonly purgedAt: string } | null> {
    const { rows } = await client.query(
      `SELECT purged_at
         FROM structured_purge_tombstones
        WHERE scope_binding = $1 AND source_ref = $2 AND purge_revision = $3`,
      [
        request.scopeBinding,
        request.sourceRef,
        request.purgeRevision,
      ]
    );
    return rows.length === 0
      ? null
      : { purgedAt: new Date(String(rows[0]!.purged_at)).toISOString() };
  }

  /**
   * The tombstone write, first of the four.
   *
   * `DO NOTHING` is belt-and-braces against the check above — the scope lock
   * already serializes two purges of the same revision — and a `RETURNING` that
   * hands back no row is still a lost write, so it is refused rather than
   * reported as a purge.
   */
  private async writeTombstone(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<void> {
    const { rows } = await client.query(
      `INSERT INTO structured_purge_tombstones
         (scope_binding, source_ref, purge_revision, purged_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (scope_binding, source_ref, purge_revision) DO NOTHING
       RETURNING scope_binding`,
      [request.scopeBinding, request.sourceRef, request.purgeRevision]
    );
    if (rows.length !== 1) {
      throw new StructuredScopeError(
        "backend_unavailable",
        `purge tombstone for ${request.sourceRef} was not persisted`
      );
    }
  }

  /**
   * Retire the source's publication lifecycle.
   *
   * The same tombstone `withdraw` writes — `active = false` plus a generation
   * bump, and the desired/published pointers cleared so no reactivation can
   * resume against a source whose content is gone. No payload row is deleted
   * here; that is MP15's ordered deletion, and it runs only after this commit.
   *
   * Returns the generation the row carries AFTER this write, because the value the
   * caller needs to publish is the one the source now has, not the one it had when
   * the lock was taken.
   */
  private async tombstoneSource(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<number> {
    const { rows } = await client.query(
      `UPDATE structured_publication_sources
          SET active = false, generation = generation + 1,
              desired_source_version = NULL, desired_extraction_revision = NULL,
              desired_config_revision = NULL, published_source_version = NULL,
              published_extraction_revision = NULL, published_generation = NULL
        WHERE scope_binding = $1 AND source_ref = $2
        RETURNING generation`,
      [request.scopeBinding, request.sourceRef]
    );
    if (rows.length !== 1) {
      throw new StructuredScopeError(
        "maintenance_status_unavailable",
        `source tombstone for ${request.sourceRef} was not persisted`
      );
    }
    return scopedSafeNumber(rows[0]!.generation, "source generation");
  }

  /**
   * Fence every job that touches this source.
   *
   * `fencing_token = NULL` is the invalidation: the running attempt's next
   * heartbeat matches no token and its next settle finds no running row, so both
   * report `lease_lost` instead of writing. The job moves to `stale` so no worker
   * can claim it afterwards, and the open attempt is closed with that same code —
   * `reclaimed` stays false, because the lease did not expire; a purge took it.
   *
   * The source is already inactive when this runs, which is what stops the
   * progress trigger from adding a second `maintenance_revision` bump on top of
   * the one this transaction owns.
   */
  private async fenceAffectedWork(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<readonly string[]> {
    const { rows } = await client.query(
      `UPDATE maintenance_jobs
          SET status = ${sqlTextLiteral(PURGE_FENCED_WORK_STATUS)},
              fencing_token = NULL, lease_expires_at = NULL,
              attempt_started_at = NULL, updated_at = now()
        WHERE source_ref = $1
          AND status IN ('pending', 'running', 'ready')
        RETURNING job_key`,
      [request.sourceRef]
    );
    const jobKeys = rows.map((row) => String(row.job_key));
    if (jobKeys.length === 0) return jobKeys;
    await client.query(
      `UPDATE maintenance_job_attempts
          SET finished_at = now(), failure_code = $2, reclaimed = false
        WHERE finished_at IS NULL AND job_key = ANY($1::text[])`,
      [jobKeys, PURGE_FENCED_ATTEMPT_FAILURE]
    );
    return jobKeys;
  }

  /**
   * The grants this purge invalidates: those whose supports reach the source, and
   * the scope's count grants.
   *
   * A count grant carries no support link by construction, but an explicit purge
   * is exactly the case that still invalidates a count through the evidence
   * contract's revision checks, so the count arm is named rather than joined for.
   * A row grant in the same scope that does not reach this source is not named:
   * the revision advance already refuses it at replay and its content is
   * untouched, so an event would announce a scrub with no cause.
   */
  private async readAffectedGrants(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<readonly AffectedGrant[]> {
    const { rows } = await client.query(
      `SELECT DISTINCT g.evidence_ref, g.consumer_id
         FROM evidence_grants g
         JOIN evidence_grant_supports gs ON gs.evidence_ref = g.evidence_ref
         JOIN assertion_supports s ON s.support_id = gs.support_id
        WHERE g.scope_binding = $1 AND s.source_ref = $2
       UNION
       SELECT g.evidence_ref, g.consumer_id
         FROM evidence_grants g
        WHERE g.scope_binding = $1 AND g.grant_kind = ${sqlTextLiteral(
          EVIDENCE_GRANT_KIND.COUNT
        )}`,
      [request.scopeBinding, request.sourceRef]
    );
    return rows.map((row) => ({
      evidenceRef: String(row.evidence_ref),
      consumerId: String(row.consumer_id ?? ""),
    }));
  }

  /**
   * Publish one `purged` event per affected grant, on that grant's own stream.
   *
   * `reason` is bound, not interpolated, and it is the only purge-shaped member
   * of the closed vocabulary: `access_revoked` is an authorization change and
   * neither may be read as an expiry (ADR 0097 §2.6).
   *
   * A grant whose `consumer_id` is blank is on no drainable stream — the column
   * defaults to `''` for rows issued before it existed — so no event can be
   * published for it. It is reported instead of dropped, because a reference that
   * vanishes without a word is a snapshot fin is never told to scrub.
   */
  private async emitInvalidations(
    client: ScopeTransactionClient,
    grants: readonly AffectedGrant[]
  ): Promise<{ readonly invalidated: string[]; readonly unpublished: string[] }> {
    const invalidated: string[] = [];
    const unpublished: string[] = [];
    for (const grant of grants) {
      if (!isBoundedConsumerId(grant.consumerId)) {
        unpublished.push(grant.evidenceRef);
        continue;
      }
      const seq = await allocateInvalidationSeq(client, grant.consumerId);
      await client.query(
        `INSERT INTO evidence_invalidation_outbox
           (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
         VALUES ($1, $2, $3::uuid, $4, $5, now())`,
        [
          grant.consumerId,
          seq,
          randomUUID(),
          grant.evidenceRef,
          INVALIDATION_REASON.PURGED,
        ]
      );
      invalidated.push(grant.evidenceRef);
    }
    return { invalidated, unpublished };
  }

  /**
   * Live leases for the source as of this transaction's snapshot.
   *
   * Reported rather than refused: a reader that started between the wait and this
   * commit is refused at grant issuance by the fence that already exists, and the
   * caller that removes payloads needs the number to know whether it still holds.
   */
  private async readActiveLeaseCount(
    client: ScopeTransactionClient,
    request: StructuredPurgeRequest
  ): Promise<number> {
    const { rows } = await client.query(ACTIVE_LEASE_SQL, [
      request.scopeBinding,
      [request.sourceRef],
    ]);
    return toActiveLeaseWindow(rows[0] ?? {}).active;
  }

  private async lease(): Promise<ScopeTransactionClient> {
    return this.pool.connect();
  }
}