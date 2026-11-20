-- P0-3 / GitHub #81: workspace DLP policies, workspace audit view/export, workspace
-- session management and workspace security settings.
--
-- Additive only. No existing table, column, policy or grant is changed and RLS is not
-- weakened anywhere:
--   * workspace.security_settings is a new tenant-scoped singleton per workspace. It stores
--     policy values only (require_2fa, session timeout, DLP switch, retention window); the
--     immutable security_mode stays on workspace.workspaces and the V16 trigger still
--     rejects any mode change.
--   * workspace.dlp_policies stores bounded literal keywords / bounded `*` glob patterns.
--     The pattern column is never interpreted as a regular expression by the application,
--     so a stored pattern cannot cause ReDoS.
--   * workspace.dlp_events is append-only and content-free by construction: it has no
--     message text, ciphertext, file name, email or IP column. Only ids, the rule name
--     snapshot and the action are stored.
--   * workspace.audit_page(...) is a read-only SECURITY DEFINER function over the existing
--     append-only audit.audit_events table. It returns only the contract columns and
--     re-checks the caller's ACTIVE OWNER/ADMIN membership, so a caller who bypasses the
--     HTTP guard still gets zero rows. The audit hash chain is untouched.
--   * workspace.security_member_subjects(...) is a read-only SECURITY DEFINER lookup that
--     maps ACTIVE workspace members to their Keycloak subject. auth.user_identities is
--     self-scoped RLS (V6), so an OWNER/ADMIN cannot read another member's identity link
--     through the runtime role without this narrow function. It returns only user_id and
--     the opaque subject; email, device names and tokens never cross this boundary.
--
-- The SECURITY DEFINER functions follow the V24/V25/V27 pattern: they are owned by the
-- migration role (superuser/BYPASSRLS in dev/test; production DBAs provision the same
-- split), revoke PUBLIC and grant EXECUTE to krug_app only.

-- ---------------------------------------------------------------------------------
-- Workspace security settings (one row per workspace).
-- ---------------------------------------------------------------------------------
CREATE TABLE workspace.security_settings (
  workspace_id              uuid PRIMARY KEY
                            REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  require_2fa               boolean NOT NULL DEFAULT false,
  session_timeout_minutes   integer NOT NULL DEFAULT 60
                            CHECK (session_timeout_minutes BETWEEN 15 AND 10080),
  dlp_enabled               boolean NOT NULL DEFAULT false,
  retention_days            integer NOT NULL DEFAULT 180
                            CHECK (retention_days BETWEEN 1 AND 3650),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE workspace.security_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.security_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY p_security_settings_tenant ON workspace.security_settings
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON workspace.security_settings TO krug_app;

COMMENT ON TABLE workspace.security_settings IS
  'P0-3 workspace security policy values; one row per workspace, tenant RLS.';
COMMENT ON COLUMN workspace.security_settings.retention_days IS
  'Requested retention window; enforcement stays with the existing retention job.';

-- Existing workspaces start from the documented defaults; new workspaces are inserted on
-- the first GET/PATCH by the application (INSERT ... ON CONFLICT DO NOTHING).
INSERT INTO workspace.security_settings (workspace_id)
SELECT w.id FROM workspace.workspaces w
ON CONFLICT (workspace_id) DO NOTHING;

-- ---------------------------------------------------------------------------------
-- DLP policies: bounded literal keywords / `*` glob patterns, never regex.
-- ---------------------------------------------------------------------------------
CREATE TABLE workspace.dlp_policies (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  action       text NOT NULL CHECK (action IN ('WARN', 'BLOCK')),
  pattern_type text NOT NULL CHECK (pattern_type IN ('KEYWORD', 'PATTERN')),
  -- 1..200 characters; the application rejects control characters and more than 20
  -- wildcard segments. PostgreSQL never interprets this value as a regular expression.
  pattern      text NOT NULL CHECK (char_length(pattern) BETWEEN 1 AND 200),
  enabled      boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_dlp_policies_ws_name
  ON workspace.dlp_policies (workspace_id, lower(name));
CREATE INDEX ix_dlp_policies_ws_created
  ON workspace.dlp_policies (workspace_id, created_at DESC, id DESC);
CREATE INDEX ix_dlp_policies_ws_enabled
  ON workspace.dlp_policies (workspace_id)
  WHERE enabled;

ALTER TABLE workspace.dlp_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.dlp_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY p_dlp_policies_tenant ON workspace.dlp_policies
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.dlp_policies TO krug_app;

COMMENT ON TABLE workspace.dlp_policies IS
  'P0-3 DLP rules: bounded literal keywords / `*` globs, never compiled as regex.';
COMMENT ON COLUMN workspace.dlp_policies.pattern IS
  'Literal matching value (KEYWORD substring or PATTERN with `*`); no regex semantics.';

-- ---------------------------------------------------------------------------------
-- DLP events: append-only, content-free. No message text / ciphertext / file / email / IP.
-- ---------------------------------------------------------------------------------
CREATE TABLE workspace.dlp_events (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  -- Rule deletion must not erase the historical decision; the id is nullable and the
  -- name snapshot below preserves the audit meaning.
  policy_id    uuid REFERENCES workspace.dlp_policies(id) ON DELETE SET NULL,
  rule_name    text NOT NULL CHECK (char_length(rule_name) BETWEEN 1 AND 120),
  action       text NOT NULL CHECK (action IN ('WARN', 'BLOCK')),
  actor_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  chat_id      uuid REFERENCES chat.chats(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_dlp_events_ws_created
  ON workspace.dlp_events (workspace_id, created_at DESC, id DESC);
CREATE INDEX ix_dlp_events_ws_policy_created
  ON workspace.dlp_events (workspace_id, policy_id, created_at DESC);
CREATE INDEX ix_dlp_events_ws_action_created
  ON workspace.dlp_events (workspace_id, action, created_at DESC);

ALTER TABLE workspace.dlp_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.dlp_events FORCE ROW LEVEL SECURITY;
CREATE POLICY p_dlp_events_tenant ON workspace.dlp_events
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

-- Append-only: no UPDATE/DELETE for the runtime role.
GRANT SELECT, INSERT ON workspace.dlp_events TO krug_app;

COMMENT ON TABLE workspace.dlp_events IS
  'P0-3 DLP decision log: ids/rule name/action only, no message content or PII.';

-- ---------------------------------------------------------------------------------
-- Workspace audit page/export (read-only, OWNER/ADMIN checked in SQL).
--
-- The existing audit.audit_events table is reused unchanged. The function returns only the
-- contract columns; metadata JSONB (which may contain counts), hash-chain bytes, request id
-- and actor email are deliberately not part of the result. The workspace filter is
-- explicit, so the caller's own events from another workspace can never leak in (the V6
-- RLS policy also allows actor_id = current_user_id across tenants).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.audit_page(
    p_workspace_id uuid,
    p_caller_id uuid,
    p_action text,
    p_actor_id uuid,
    p_from timestamptz,
    p_to timestamptz,
    p_limit integer,
    p_cursor_created_at timestamptz,
    p_cursor_id uuid)
  RETURNS TABLE (
    id uuid,
    action text,
    actor_id uuid,
    target_type text,
    target_id uuid,
    created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT e.id,
       e.action,
       e.actor_id,
       e.target_type,
       e.target_id,
       e.created_at
  FROM audit.audit_events e
 WHERE e.workspace_id = p_workspace_id
   AND (p_action IS NULL OR e.action = p_action)
   AND (p_actor_id IS NULL OR e.actor_id = p_actor_id)
   AND (p_from IS NULL OR e.created_at >= p_from)
   AND (p_to IS NULL OR e.created_at <= p_to)
   AND (p_cursor_created_at IS NULL
        OR (e.created_at, e.id) < (p_cursor_created_at, p_cursor_id))
   AND EXISTS (
       SELECT 1
         FROM workspace.memberships m
         JOIN workspace.workspaces w
           ON w.id = m.workspace_id
          AND w.status = 'ACTIVE'
        WHERE m.workspace_id = p_workspace_id
          AND m.user_id = p_caller_id
          AND m.status = 'ACTIVE'
          AND m.role IN ('OWNER', 'ADMIN')
          AND p_caller_id = ops.current_user_id()
   )
 ORDER BY e.created_at DESC, e.id DESC
 LIMIT LEAST(GREATEST(p_limit, 1), 10001)
$$;

REVOKE ALL ON FUNCTION workspace.audit_page(uuid, uuid, text, uuid, timestamptz, timestamptz,
                                            integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.audit_page(uuid, uuid, text, uuid, timestamptz, timestamptz,
                                               integer, timestamptz, uuid) TO krug_app;

COMMENT ON FUNCTION workspace.audit_page(uuid, uuid, text, uuid, timestamptz, timestamptz,
                                         integer, timestamptz, uuid) IS
  'P0-3 workspace audit page: contract columns only, explicit workspace filter, caller OWNER/ADMIN checked in SQL';

-- ---------------------------------------------------------------------------------
-- Keycloak subjects of ACTIVE workspace members (read-only).
--
-- Used only to address the Keycloak Admin API for session list/revoke. The application
-- re-checks the manager role before calling; the function repeats the check so a bypass
-- yields no rows. No display name, email, device or token data is returned.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.security_member_subjects(
    p_workspace_id uuid,
    p_caller_id uuid)
  RETURNS TABLE (
    user_id uuid,
    keycloak_subject text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT m.user_id,
       i.subject
  FROM workspace.memberships caller
  JOIN workspace.memberships m
    ON m.workspace_id = caller.workspace_id
   AND m.status = 'ACTIVE'
  JOIN workspace.workspaces w
    ON w.id = m.workspace_id
   AND w.status = 'ACTIVE'
  JOIN auth.user_identities i
    ON i.user_id = m.user_id
   AND i.provider = 'keycloak'
 WHERE caller.workspace_id = p_workspace_id
   AND caller.user_id = p_caller_id
   AND caller.status = 'ACTIVE'
   AND caller.role IN ('OWNER', 'ADMIN')
   AND p_caller_id = ops.current_user_id()
 ORDER BY m.user_id ASC
 LIMIT 1000
$$;

REVOKE ALL ON FUNCTION workspace.security_member_subjects(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.security_member_subjects(uuid, uuid) TO krug_app;

COMMENT ON FUNCTION workspace.security_member_subjects(uuid, uuid) IS
  'P0-3 Keycloak subjects of ACTIVE members for an ACTIVE OWNER/ADMIN caller; ids only, no PII';

-- Forward-only rollback plan:
--   DROP FUNCTION workspace.security_member_subjects(uuid, uuid);
--   DROP FUNCTION workspace.audit_page(uuid, uuid, text, uuid, timestamptz, timestamptz,
--                                      integer, timestamptz, uuid);
--   DROP TABLE workspace.dlp_events;
--   DROP TABLE workspace.dlp_policies;
--   DROP TABLE workspace.security_settings;
-- DLP rules/events and security settings are lost on rollback. Existing audit rows,
-- workspaces, memberships, chats, messages and RLS policies are untouched.
