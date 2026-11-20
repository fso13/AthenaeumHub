-- #84: workspace overview aggregates, platform-admin audit export / session endpoints and
-- the runtime translation-provider setting.
--
-- Additive only. No existing table, column, policy or grant is changed:
--   * workspace.overview_stats(...) is a read-only SECURITY DEFINER aggregate. It returns
--     counts and byte totals only (never a message body, filename, E2EE envelope or actor
--     identity) and re-checks the caller's ACTIVE membership, so a bypass still yields no
--     row. The audit preview stays on workspace.audit_page (OWNER/ADMIN only).
--   * ops.admin_audit_export(...) is the bounded (<= 10001 rows) platform-audit export
--     reader. It returns only the seven columns of the AdminAuditEvent contract; metadata,
--     hash-chain bytes and request ids never leave the database. The caller must still be
--     an ACTIVE platform admin in SQL, on top of the application guard.
--   * ops.admin_user_subject(...) maps a local user id to its opaque Keycloak subject for
--     the platform-admin session endpoints. auth.user_identities is self-scoped RLS, so the
--     function re-checks the platform-admin caller; email/username/IP/tokens are not
--     returned.
--   * ops.plugin_translation_settings is installation configuration (no secrets: a boolean
--     and an https URL). It is intentionally not tenant-scoped, exactly like
--     ops.system_settings, and only the runtime/administrator role can read or write it.
--
-- The three new indexes back the new bounded reads (workspace chat/attachment counts, the
-- 24h message window and the platform-audit export ordering). They are ordinary additive
-- indexes; no table is rewritten.

-- ---------------------------------------------------------------------------------
-- Covering indexes for the workspace overview and the global audit export.
-- ---------------------------------------------------------------------------------
CREATE INDEX ix_chats_ws_active
  ON chat.chats (workspace_id)
  WHERE deleted_at IS NULL;

-- Parent index on the partitioned timeline: PostgreSQL creates the matching index on every
-- existing and future partition, so the 24h workspace window is a bounded index scan.
CREATE INDEX ix_messages_ws_created
  ON message.messages (workspace_id, created_at DESC);

CREATE INDEX ix_audit_events_created
  ON audit.audit_events (created_at DESC, id DESC);

-- ---------------------------------------------------------------------------------
-- Workspace overview aggregates (membership-scoped, content-free).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.overview_stats(
    p_workspace_id uuid,
    p_caller_id uuid,
    p_now timestamptz)
  RETURNS TABLE (
    members_total bigint,
    chats_total bigint,
    messages_total bigint,
    messages_last_24h bigint,
    files_total bigint,
    files_used_bytes bigint,
    files_reserved_bytes bigint,
    storage_quota_bytes bigint,
    dlp_events_last_24h bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT
  (SELECT count(*)::bigint
     FROM workspace.memberships m
     JOIN auth.users u ON u.id = m.user_id AND u.status = 'ACTIVE'
    WHERE m.workspace_id = p_workspace_id
      AND m.status = 'ACTIVE') AS members_total,
  (SELECT count(*)::bigint
     FROM chat.chats c
    WHERE c.workspace_id = p_workspace_id
      AND c.deleted_at IS NULL) AS chats_total,
  -- Cumulative allocated message sequences. This is the same bounded aggregate the admin
  -- chat list uses; it never scans the partitioned message timeline.
  (SELECT COALESCE(sum(GREATEST(cc.next_seq - 1, 0)), 0)::bigint
     FROM chat.chat_counters cc
     JOIN chat.chats c ON c.id = cc.chat_id AND c.deleted_at IS NULL
    WHERE cc.workspace_id = p_workspace_id) AS messages_total,
  (SELECT count(*)::bigint
     FROM message.messages msg
    WHERE msg.workspace_id = p_workspace_id
      AND msg.created_at >= p_now - interval '24 hours'
      AND msg.deleted_at IS NULL) AS messages_last_24h,
  (SELECT count(*)::bigint
     FROM file.attachments a
    WHERE a.workspace_id = p_workspace_id
      AND a.status IN ('READY', 'BOUND')
      AND a.deleted_at IS NULL) AS files_total,
  COALESCE((SELECT uu.used_bytes
              FROM file.workspace_usage uu
             WHERE uu.workspace_id = p_workspace_id), 0)::bigint AS files_used_bytes,
  COALESCE((SELECT uu.reserved_bytes
              FROM file.workspace_usage uu
             WHERE uu.workspace_id = p_workspace_id), 0)::bigint AS files_reserved_bytes,
  -- A workspace that has never used files has no limits row yet; report the documented
  -- default quota instead of a misleading zero.
  COALESCE((SELECT l.storage_bytes
              FROM file.workspace_limits l
             WHERE l.workspace_id = p_workspace_id), 1099511627776)::bigint
    AS storage_quota_bytes,
  (SELECT count(*)::bigint
     FROM workspace.dlp_events d
    WHERE d.workspace_id = p_workspace_id
      AND d.created_at >= p_now - interval '24 hours') AS dlp_events_last_24h
 WHERE EXISTS (
         SELECT 1
           FROM workspace.memberships m
           JOIN workspace.workspaces w
             ON w.id = m.workspace_id
            AND w.status = 'ACTIVE'
          WHERE m.workspace_id = p_workspace_id
            AND m.user_id = p_caller_id
            AND m.status = 'ACTIVE'
            AND p_caller_id = ops.current_user_id())
$$;

REVOKE ALL ON FUNCTION workspace.overview_stats(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.overview_stats(uuid, uuid, timestamptz) TO krug_app;

COMMENT ON FUNCTION workspace.overview_stats(uuid, uuid, timestamptz) IS
  '#84 workspace overview: membership-scoped counts/bytes only, no row content';

-- ---------------------------------------------------------------------------------
-- Bounded platform-audit export reader.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.admin_audit_export(
    p_action text,
    p_limit integer,
    p_caller_id uuid)
  RETURNS TABLE (
    id uuid,
    action text,
    actor_id uuid,
    actor_email text,
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
       u.email::text,
       e.target_type,
       e.target_id,
       e.created_at
  FROM audit.audit_events e
  LEFT JOIN auth.users u ON u.id = e.actor_id
 WHERE (p_action IS NULL OR e.action = p_action)
   AND EXISTS (
         SELECT 1
           FROM auth.users caller
          WHERE caller.id = p_caller_id
            AND caller.is_platform_admin
            AND caller.status = 'ACTIVE'
            AND p_caller_id = ops.current_user_id())
 ORDER BY e.created_at DESC, e.id DESC
 LIMIT LEAST(GREATEST(p_limit, 1), 10001)
$$;

REVOKE ALL ON FUNCTION ops.admin_audit_export(text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.admin_audit_export(text, integer, uuid) TO krug_app;

COMMENT ON FUNCTION ops.admin_audit_export(text, integer, uuid) IS
  '#84 bounded platform audit export: contract columns only, at most 10001 rows';

-- ---------------------------------------------------------------------------------
-- Platform-admin session support: local user -> opaque Keycloak subject.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.admin_user_subject(
    p_user_id uuid,
    p_caller_id uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT i.subject
  FROM auth.user_identities i
  JOIN auth.users target
    ON target.id = i.user_id
   AND target.status = 'ACTIVE'
 WHERE i.user_id = p_user_id
   AND i.provider = 'keycloak'
   AND EXISTS (
         SELECT 1
           FROM auth.users caller
          WHERE caller.id = p_caller_id
            AND caller.is_platform_admin
            AND caller.status = 'ACTIVE'
            AND p_caller_id = ops.current_user_id())
 LIMIT 1
$$;

REVOKE ALL ON FUNCTION ops.admin_user_subject(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.admin_user_subject(uuid, uuid) TO krug_app;

COMMENT ON FUNCTION ops.admin_user_subject(uuid, uuid) IS
  '#84 platform-admin session lookup: opaque Keycloak subject only, no PII';

-- ---------------------------------------------------------------------------------
-- Runtime translation-provider configuration. No secret column: the provider is
-- addressed by an https URL only; API keys are not supported by this contract.
-- ---------------------------------------------------------------------------------
CREATE TABLE ops.plugin_translation_settings (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     boolean NOT NULL DEFAULT false,
  url         text CHECK (url IS NULL OR length(url) BETWEEN 1 AND 2048),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

GRANT SELECT, INSERT, UPDATE ON ops.plugin_translation_settings TO krug_app;

COMMENT ON TABLE ops.plugin_translation_settings IS
  '#84 installation translation-provider switch/URL; no credential is stored';
COMMENT ON COLUMN ops.plugin_translation_settings.url IS
  'Absolute https URL (optional path). Validated by the application; never logged.';
