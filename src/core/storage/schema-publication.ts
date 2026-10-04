/** Additive DDL for the authoritative structured-publication unit of work. */
import type { SchemaClient } from "./schema-projection.js";

export async function upSchemaPublication(client: SchemaClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_publication_scopes (
      scope_binding text PRIMARY KEY CHECK (length(scope_binding) > 0),
      read_revision bigint NOT NULL DEFAULT 0 CHECK (read_revision >= 0),
      maintenance_revision bigint NOT NULL DEFAULT 0 CHECK (maintenance_revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_publication_sources (
      scope_binding text NOT NULL REFERENCES structured_publication_scopes(scope_binding) ON DELETE CASCADE,
      source_ref text NOT NULL CHECK (length(source_ref) > 0),
      active boolean NOT NULL DEFAULT true,
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      desired_source_version text,
      desired_extraction_revision bigint CHECK (desired_extraction_revision >= 0),
      desired_config_revision text,
      published_source_version text,
      published_extraction_revision bigint CHECK (published_extraction_revision >= 0),
      published_generation bigint CHECK (published_generation >= 0),
      PRIMARY KEY (scope_binding, source_ref),
      UNIQUE (source_ref),
      CHECK ((desired_source_version IS NULL) = (desired_extraction_revision IS NULL)),
      CHECK ((desired_source_version IS NULL) = (desired_config_revision IS NULL)),
      CHECK ((published_source_version IS NULL) = (published_extraction_revision IS NULL)),
      CHECK ((published_source_version IS NULL) = (published_generation IS NULL)),
      FOREIGN KEY (source_ref, desired_source_version)
        REFERENCES source_versions(source_ref, source_version),
      FOREIGN KEY (source_ref, published_source_version)
        REFERENCES source_versions(source_ref, source_version)
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_publication_membership (
      scope_binding text NOT NULL,
      source_ref text NOT NULL,
      generation bigint NOT NULL CHECK (generation >= 0),
      extraction_ref text NOT NULL CHECK (length(extraction_ref) > 0),
      support_id uuid NOT NULL REFERENCES assertion_supports(support_id),
      subject text NOT NULL CHECK (subject IN ('entity', 'assertion')),
      result_id text NOT NULL CHECK (length(result_id) > 0),
      PRIMARY KEY (scope_binding, source_ref, support_id),
      FOREIGN KEY (scope_binding, source_ref)
        REFERENCES structured_publication_sources(scope_binding, source_ref) ON DELETE CASCADE
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_publication_display (
      scope_binding text NOT NULL,
      source_ref text NOT NULL,
      support_id uuid NOT NULL REFERENCES assertion_supports(support_id),
      extraction_revision bigint NOT NULL CHECK (extraction_revision >= 0),
      canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) > 0),
      entity_type text NOT NULL CHECK (entity_type IN ('person', 'organization', 'place', 'event')),
      CONSTRAINT structured_publication_display_pkey
        PRIMARY KEY (scope_binding, source_ref, support_id, extraction_revision),
      FOREIGN KEY (scope_binding, source_ref)
        REFERENCES structured_publication_sources(scope_binding, source_ref) ON DELETE CASCADE
    )`);
  await client.query(`ALTER TABLE structured_publication_display
    ADD COLUMN IF NOT EXISTS extraction_revision bigint NOT NULL DEFAULT 0
      CHECK (extraction_revision >= 0)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_publication_extraction_bindings (
      scope_binding text NOT NULL,
      source_ref text NOT NULL,
      source_version text NOT NULL CHECK (length(source_version) > 0),
      extraction_revision bigint NOT NULL CHECK (extraction_revision >= 0),
      config_revision text NOT NULL CHECK (length(config_revision) > 0),
      extraction_ref text NOT NULL CHECK (length(extraction_ref) > 0),
      payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT structured_publication_extraction_bindings_pkey
        PRIMARY KEY (scope_binding, source_ref, source_version, extraction_revision),
      FOREIGN KEY (scope_binding, source_ref)
        REFERENCES structured_publication_sources(scope_binding, source_ref) ON DELETE CASCADE,
      FOREIGN KEY (source_ref, source_version)
        REFERENCES source_versions(source_ref, source_version)
    )`);
  // Sentinel defaults make any pre-binding rows fail closed: a reused revision
  // cannot mistake incomplete history for a verified input/output binding.
  await client.query(`ALTER TABLE structured_publication_extraction_bindings
    ADD COLUMN IF NOT EXISTS extraction_revision bigint NOT NULL DEFAULT 0
      CHECK (extraction_revision >= 0)`);
  await client.query(`ALTER TABLE structured_publication_extraction_bindings
    ADD COLUMN IF NOT EXISTS config_revision text NOT NULL DEFAULT 'legacy-unbound'
      CHECK (length(config_revision) > 0)`);
  await client.query(`ALTER TABLE structured_publication_extraction_bindings
    ADD COLUMN IF NOT EXISTS extraction_ref text NOT NULL DEFAULT 'legacy-unbound'
      CHECK (length(extraction_ref) > 0)`);
  await client.query(`ALTER TABLE structured_publication_extraction_bindings
    ADD COLUMN IF NOT EXISTS payload_digest text NOT NULL
      DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
      CHECK (payload_digest ~ '^[0-9a-f]{64}$')`);
  await client.query(`
    DO $publication$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'structured_publication_display'::regclass
           AND conname = 'structured_publication_display_pkey'
           AND pg_get_constraintdef(oid) = 'PRIMARY KEY (scope_binding, source_ref, support_id)'
      ) THEN
        ALTER TABLE structured_publication_display
          DROP CONSTRAINT structured_publication_display_pkey;
        ALTER TABLE structured_publication_display
          ADD CONSTRAINT structured_publication_display_pkey
          PRIMARY KEY (scope_binding, source_ref, support_id, extraction_revision);
      END IF;
    END;
    $publication$`);

  // Keep the readiness probe's index list in lockstep with emitted DDL. On a
  // normal schema these names are already owned by the primary-key constraints;
  // IF NOT EXISTS also repairs a missing index on an existing table.
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS structured_publication_display_pkey
    ON structured_publication_display (scope_binding, source_ref, support_id, extraction_revision)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS structured_publication_extraction_bindings_pkey
    ON structured_publication_extraction_bindings (scope_binding, source_ref, source_version, extraction_revision)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_publication_stages (
      scope_binding text NOT NULL,
      source_ref text NOT NULL,
      generation bigint NOT NULL CHECK (generation >= 0),
      job_key text NOT NULL,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      fencing_token text NOT NULL,
      extraction_ref text NOT NULL CHECK (length(extraction_ref) > 0),
      accepted_facts jsonb NOT NULL CHECK (jsonb_typeof(accepted_facts) = 'array'),
      staged_at timestamptz NOT NULL,
      PRIMARY KEY (scope_binding, source_ref),
      FOREIGN KEY (scope_binding, source_ref)
        REFERENCES structured_publication_sources(scope_binding, source_ref) ON DELETE CASCADE
    )`);

  await client.query(`CREATE INDEX IF NOT EXISTS structured_publication_sources_scope_idx
    ON structured_publication_sources (scope_binding, active, source_ref)`);
  await client.query(`CREATE INDEX IF NOT EXISTS structured_publication_membership_read_idx
    ON structured_publication_membership (scope_binding, source_ref, generation, subject, result_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS structured_publication_stages_guard_idx
    ON structured_publication_stages (job_key, attempt_number, fencing_token)`);

  await client.query(`
    CREATE OR REPLACE FUNCTION structured_publication_advance_work_revision()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $publication$
    BEGIN
      UPDATE structured_publication_scopes AS p
         SET maintenance_revision = p.maintenance_revision + 1
       WHERE EXISTS (
         SELECT 1 FROM structured_publication_sources AS s
          WHERE s.scope_binding = p.scope_binding
            AND s.source_ref = NEW.source_ref
            AND s.active
            AND s.generation = NEW.source_generation
       );
      RETURN NEW;
    END;
    $publication$`);
  await client.query(
    `DROP TRIGGER IF EXISTS maintenance_jobs_publication_progress_trg ON maintenance_jobs`
  );
  await client.query(`
    CREATE TRIGGER maintenance_jobs_publication_progress_trg
    AFTER INSERT OR UPDATE OF status, source_ref, source_generation, source_version,
      input_revision, config_revision
    ON maintenance_jobs
    FOR EACH ROW
    EXECUTE FUNCTION structured_publication_advance_work_revision()`);
}
