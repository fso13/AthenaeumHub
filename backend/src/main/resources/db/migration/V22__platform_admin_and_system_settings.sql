-- E8-B: first-run platform admin + singleton runtime settings (R-01…R-04).
--
-- Design notes:
--   * auth.users.is_platform_admin is assigned to the first local user. The assignment is
--     serialized by a transaction-scoped advisory lock inside auth.claim_platform_admin(),
--     so two concurrent JIT provisions cannot both become admin. A partial unique index is
--     the hard backstop: at most one platform admin exists (multiple admins are out of
--     scope for v1.1).
--   * The claim function is SECURITY DEFINER because auth.users is FORCE RLS: the caller
--     can only see their own row, which is not enough to answer "is there any admin?".
--   * Existing installations are upgraded safely by promoting the earliest user, so an
--     upgrade never leaves a running install without an admin.
--   * ops.system_settings is a global singleton (id = 1). It is intentionally not
--     tenant-scoped: it is installation configuration, not workspace data. The SMTP
--     password is stored only as AES-GCM ciphertext (ops.system_settings is never exposed
--     through a generic repository API). The application-level platform-admin guard gates
--     all mutations.
--   * ops.platform_overview() is SECURITY DEFINER for the same RLS reason: an admin needs
--     aggregate counts across all tenants, but no row-level access.

ALTER TABLE auth.users
  ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

-- Upgrade path: promote the earliest existing local user before the unique backstop is
-- created. On a fresh database the table is empty and the first JIT user is promoted by
-- auth.claim_platform_admin().
UPDATE auth.users
   SET is_platform_admin = true
 WHERE id = (
         SELECT id
           FROM auth.users
          ORDER BY created_at ASC, id ASC
          LIMIT 1
       )
   AND NOT EXISTS (SELECT 1 FROM auth.users WHERE is_platform_admin);

CREATE UNIQUE INDEX ux_users_single_platform_admin
  ON auth.users (is_platform_admin)
  WHERE is_platform_admin;

CREATE OR REPLACE FUNCTION auth.claim_platform_admin() RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = auth, pg_catalog
  AS $$
DECLARE
  first_admin boolean;
BEGIN
  -- One claim at a time. The lock is released when the caller's transaction ends, so the
  -- check and the INSERT of the claiming user are atomic with respect to other claims.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.users.platform_admin', 0));
  SELECT NOT EXISTS (SELECT 1 FROM auth.users WHERE is_platform_admin)
    INTO first_admin;
  RETURN first_admin;
END
$$;

REVOKE ALL ON FUNCTION auth.claim_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.claim_platform_admin() TO krug_app;

CREATE TABLE ops.system_settings (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  setup_completed_at       timestamptz,
  smtp_host                text CHECK (smtp_host IS NULL OR length(smtp_host) BETWEEN 1 AND 255),
  smtp_port                integer CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  smtp_username            text CHECK (smtp_username IS NULL OR length(smtp_username) <= 255),
  -- AES-256-GCM ciphertext only; the plaintext password never reaches this table.
  smtp_password_ciphertext bytea,
  smtp_from                text CHECK (smtp_from IS NULL OR length(smtp_from) BETWEEN 1 AND 254),
  smtp_starttls            boolean NOT NULL DEFAULT true,
  max_chats_per_user       integer NOT NULL DEFAULT 100
                           CHECK (max_chats_per_user BETWEEN 1 AND 1000000),
  max_chats_per_workspace  integer NOT NULL DEFAULT 1000
                           CHECK (max_chats_per_workspace BETWEEN 1 AND 1000000),
  max_workspace_members    integer NOT NULL DEFAULT 100
                           CHECK (max_workspace_members BETWEEN 1 AND 1000000),
  registration_open        boolean NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO ops.system_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON ops.system_settings TO krug_app;

CREATE OR REPLACE FUNCTION ops.platform_overview()
  RETURNS TABLE(total_users bigint, total_workspaces bigint, total_chats bigint)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = auth, workspace, chat, pg_catalog
  AS $$
SELECT (SELECT count(*) FROM auth.users WHERE status <> 'DELETED'),
       (SELECT count(*) FROM workspace.workspaces WHERE status <> 'DELETED'),
       (SELECT count(*) FROM chat.chats WHERE deleted_at IS NULL)
$$;

REVOKE ALL ON FUNCTION ops.platform_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_overview() TO krug_app;
