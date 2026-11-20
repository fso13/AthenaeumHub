-- D1.2 (#86): external plugin packages.
--
-- Scope:
--   * Admin-only ZIP upload of a static plugin package. The archive is validated in the
--     application (no traversal, no symlinks, bounded file count/size) and never
--     extracted to the server filesystem.
--   * Assets are stored in the existing S3/MinIO object storage; PostgreSQL keeps only
--     opaque object keys, sizes and SHA-256 digests.
--   * A catalog row is created with kind=EXTERNAL / install_state=INSTALLED so the
--     existing GET /plugins and per-chat toggle code keeps working unchanged.
--   * No plugin server code is executed; there is no runtime, sandbox process, network
--     call or capability token in this slice.
--
-- Additive and RLS-safe:
--   * plugin.catalog gains kind/install_state/version/author/entry. Built-in rows keep
--     their current values via defaults.
--   * The catalog keeps its global read policy, but write access for krug_app is limited
--     by RLS to kind='EXTERNAL' rows: the application role can never mutate or delete a
--     built-in first-party plugin. FORCE RLS is intentionally not enabled so the
--     migrator (table owner) can keep seeding built-ins.
--   * plugin.packages / plugin.package_objects are global metadata (no workspace data,
--     no user content, no secrets) and therefore have no RLS, exactly like the catalog.

-- ---------------------------------------------------------------------------------
-- Catalog: external package metadata.
-- ---------------------------------------------------------------------------------
ALTER TABLE plugin.catalog
  ADD COLUMN kind text NOT NULL DEFAULT 'BUILTIN'
      CHECK (kind IN ('BUILTIN', 'EXTERNAL')),
  ADD COLUMN install_state text NOT NULL DEFAULT 'INSTALLED'
      CHECK (install_state IN ('INSTALLED', 'UNINSTALLED')),
  ADD COLUMN version text,
  ADD COLUMN author text,
  ADD COLUMN entry text;

ALTER TABLE plugin.catalog
  ADD CONSTRAINT ck_plugin_catalog_external_metadata CHECK (
    (kind = 'BUILTIN'
       AND version IS NULL AND author IS NULL AND entry IS NULL)
    OR
    (kind = 'EXTERNAL'
       AND version IS NOT NULL AND author IS NOT NULL AND entry IS NOT NULL)
  );

-- The old CHECK only allowed the four built-in permission names. External manifests use
-- the documented dotted vocabulary; both sets are closed and validated by the app too.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'plugin.catalog'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%permissions%'
  LOOP
    EXECUTE format('ALTER TABLE plugin.catalog DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE plugin.catalog
  ADD CONSTRAINT ck_plugin_catalog_permissions CHECK (
    permissions <@ ARRAY[
      'MESSAGES', 'MEMBERS', 'FILES', 'WEBHOOKS',
      'chat.messages.read', 'chat.messages.write', 'chat.members.read',
      'chat.files.read', 'chat.files.write', 'webhooks.send'
    ]::text[]
  );

CREATE INDEX ix_plugin_catalog_kind_install
  ON plugin.catalog (kind, install_state, sort_order, id);

-- External-only write surface for the application role. A SELECT policy keeps the
-- catalog readable by every authenticated caller exactly as before.
ALTER TABLE plugin.catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_catalog_read ON plugin.catalog
  FOR SELECT USING (true);
CREATE POLICY p_plugin_catalog_insert_external ON plugin.catalog
  FOR INSERT WITH CHECK (kind = 'EXTERNAL');
CREATE POLICY p_plugin_catalog_update_external ON plugin.catalog
  FOR UPDATE USING (kind = 'EXTERNAL') WITH CHECK (kind = 'EXTERNAL');
CREATE POLICY p_plugin_catalog_delete_external ON plugin.catalog
  FOR DELETE USING (kind = 'EXTERNAL');

GRANT INSERT, UPDATE, DELETE ON plugin.catalog TO krug_app;

COMMENT ON COLUMN plugin.catalog.kind IS
  'BUILTIN first-party row or EXTERNAL admin-installed package.';
COMMENT ON COLUMN plugin.catalog.install_state IS
  'INSTALLED rows are visible to clients; UNINSTALLED external rows are hidden.';
COMMENT ON COLUMN plugin.catalog.version IS
  'External package semantic version; NULL for built-ins.';
COMMENT ON COLUMN plugin.catalog.author IS
  'External package author display name; NULL for built-ins.';
COMMENT ON COLUMN plugin.catalog.entry IS
  'External package HTML entry path inside the package; NULL for built-ins.';

-- ---------------------------------------------------------------------------------
-- External package metadata.
-- ---------------------------------------------------------------------------------
CREATE TABLE plugin.packages (
  plugin_id           text PRIMARY KEY
                      REFERENCES plugin.catalog(id) ON DELETE CASCADE,
  archive_sha256      text NOT NULL
                      CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_size_bytes  bigint NOT NULL
                      CHECK (archive_size_bytes BETWEEN 1 AND 5242880),
  unpacked_size_bytes bigint NOT NULL
                      CHECK (unpacked_size_bytes BETWEEN 1 AND 10485760),
  file_count          integer NOT NULL
                      CHECK (file_count BETWEEN 1 AND 200),
  entry               text NOT NULL
                      CHECK (length(entry) BETWEEN 1 AND 512
                             AND entry ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  installed_by        uuid NOT NULL,
  installed_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE plugin.packages IS
  'D1.2 admin-installed external plugin package metadata. No executable code.';
COMMENT ON COLUMN plugin.packages.archive_size_bytes IS
  'Raw ZIP size; bounded by the 5 MiB upload limit.';
COMMENT ON COLUMN plugin.packages.unpacked_size_bytes IS
  'Streamed uncompressed size; bounded by the 10 MiB zip-bomb limit.';

-- ---------------------------------------------------------------------------------
-- Package assets: opaque object keys only, never file bytes or filesystem paths.
-- ---------------------------------------------------------------------------------
CREATE TABLE plugin.package_objects (
  plugin_id    text NOT NULL
               REFERENCES plugin.packages(plugin_id) ON DELETE CASCADE,
  path         text NOT NULL
               CHECK (length(path) BETWEEN 1 AND 512
                      AND path ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  object_key   text NOT NULL UNIQUE,
  content_type text NOT NULL
               CHECK (length(content_type) BETWEEN 1 AND 128),
  size_bytes   bigint NOT NULL
               CHECK (size_bytes BETWEEN 0 AND 10485760),
  sha256       text NOT NULL
               CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (plugin_id, path)
);

COMMENT ON TABLE plugin.package_objects IS
  'D1.2 package assets stored in S3/MinIO; the database keeps only metadata.';
COMMENT ON COLUMN plugin.package_objects.object_key IS
  'Opaque plugin-packages/... MinIO key; never derived from an absolute path.';

GRANT SELECT, INSERT, UPDATE, DELETE ON plugin.packages TO krug_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON plugin.package_objects TO krug_app;

-- Forward-only rollback plan (destructive, external packages only):
--   ALTER TABLE plugin.catalog DROP COLUMN entry, DROP COLUMN author,
--                               DROP COLUMN version, DROP COLUMN install_state,
--                               DROP COLUMN kind;
--   DROP TABLE plugin.package_objects;
--   DROP TABLE plugin.packages;
--   -- drop the three external-only policies and restore the V34 permissions CHECK
-- Built-in catalog rows, chat toggles, chats/messages/files are untouched.
