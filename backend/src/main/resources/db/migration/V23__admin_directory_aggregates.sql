-- E9-B: read-only admin directory (users/chats) and storage dashboard.
--
-- The platform admin authenticates as a normal user and is therefore RLS-scoped to their
-- own rows (auth.users FORCE RLS, workspace/chat/file tenant policies). The admin lists
-- need cross-tenant metadata, so every global read goes through a narrow SECURITY DEFINER
-- function. Nothing here changes RLS or grants a runtime role a broader policy:
--
--   * the functions are read-only (STABLE, no INSERT/UPDATE/DELETE);
--   * they return only metadata/aggregates, never message bodies, E2EE envelopes, filename
--     or object keys;
--   * the application still gates the endpoints with PlatformAdminGuard before calling;
--   * EXECUTE is granted to krug_app only (the runtime role), never PUBLIC.
--
-- The owner of these functions must be able to see all tenants (as for
-- ops.platform_overview() / auth.claim_platform_admin()): the migration role is the
-- superuser/BYPASSRLS role in dev/test, and production DBAs provision the same split.
--
-- Keyset pagination is (created_at DESC, id DESC); search uses position() rather than
-- LIKE so the admin query is always treated as a literal substring (no wildcard/escape
-- surprises). Only non-deleted rows are visible in the lists.

-- Stable-order support for the two keyset pages.
CREATE INDEX IF NOT EXISTS ix_users_created_at_id
  ON auth.users (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ix_chats_created_at_id
  ON chat.chats (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION ops.admin_users_page(
    p_query text,
    p_limit integer,
    p_cursor_created_at timestamptz,
    p_cursor_id uuid)
  RETURNS TABLE (
    id uuid,
    email text,
    display_name text,
    is_platform_admin boolean,
    status text,
    workspaces_count bigint,
    chats_count bigint,
    storage_used_bytes bigint,
    created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT u.id,
       u.email::text,
       u.display_name,
       u.is_platform_admin,
       u.status,
       (SELECT count(*)::bigint
          FROM workspace.memberships m
          JOIN workspace.workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = u.id
           AND m.status = 'ACTIVE'
           AND w.status <> 'DELETED') AS workspaces_count,
       (SELECT count(*)::bigint
          FROM chat.chat_members cm
          JOIN chat.chats c ON c.id = cm.chat_id
         WHERE cm.user_id = u.id
           AND cm.status = 'ACTIVE'
           AND c.deleted_at IS NULL) AS chats_count,
       (SELECT COALESCE(sum(a.size_bytes), 0)::bigint
          FROM file.attachments a
         WHERE a.user_id = u.id
           AND a.status IN ('READY', 'BOUND')) AS storage_used_bytes,
       u.created_at
  FROM auth.users u
 WHERE u.status <> 'DELETED'
   AND (p_query IS NULL
        OR position(lower(p_query) IN lower(u.email::text)) > 0
        OR position(lower(p_query) IN lower(u.display_name)) > 0)
   AND (p_cursor_created_at IS NULL
        OR (u.created_at, u.id) < (p_cursor_created_at, p_cursor_id))
 ORDER BY u.created_at DESC, u.id DESC
 LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;

CREATE OR REPLACE FUNCTION ops.admin_chats_page(
    p_workspace_id uuid,
    p_query text,
    p_type text,
    p_limit integer,
    p_cursor_created_at timestamptz,
    p_cursor_id uuid)
  RETURNS TABLE (
    id uuid,
    name text,
    type text,
    security_mode text,
    workspace_id uuid,
    workspace_name text,
    members_count bigint,
    messages_count bigint,
    created_at timestamptz,
    last_activity_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT c.id,
       c.name,
       c.type,
       c.security_mode,
       c.workspace_id,
       w.name AS workspace_name,
       (SELECT count(*)::bigint
          FROM chat.chat_members cm
         WHERE cm.chat_id = c.id
           AND cm.status = 'ACTIVE') AS members_count,
       GREATEST(COALESCE(cc.next_seq - 1, 0), 0)::bigint AS messages_count,
       c.created_at,
       c.last_message_at
  FROM chat.chats c
  JOIN workspace.workspaces w ON w.id = c.workspace_id
  LEFT JOIN chat.chat_counters cc ON cc.chat_id = c.id
 WHERE c.deleted_at IS NULL
   AND w.status <> 'DELETED'
   AND (p_workspace_id IS NULL OR c.workspace_id = p_workspace_id)
   AND (p_query IS NULL OR position(lower(p_query) IN lower(COALESCE(c.name, ''))) > 0)
   AND (p_type IS NULL OR c.type = p_type)
   AND (p_cursor_created_at IS NULL
        OR (c.created_at, c.id) < (p_cursor_created_at, p_cursor_id))
 ORDER BY c.created_at DESC, c.id DESC
 LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;

-- One row per non-deleted workspace. The application sums these rows for the totals, so
-- the filtered (single workspace) and unfiltered responses stay consistent by construction.
CREATE OR REPLACE FUNCTION ops.admin_storage_workspaces(p_workspace_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_name text,
    security_mode text,
    used_bytes bigint,
    reserved_bytes bigint,
    storage_limit_bytes bigint,
    objects bigint,
    attachments bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT w.id,
       w.name,
       w.security_mode,
       COALESCE(uu.used_bytes, 0)::bigint,
       COALESCE(uu.reserved_bytes, 0)::bigint,
       COALESCE(l.storage_bytes, 0)::bigint,
       (SELECT count(*)::bigint
          FROM file.attachments a
         WHERE a.workspace_id = w.id
           AND a.status IN ('READY', 'BOUND')) AS objects,
       (SELECT count(*)::bigint
          FROM file.attachments a
         WHERE a.workspace_id = w.id
           AND a.status <> 'DELETED') AS attachments
  FROM workspace.workspaces w
  LEFT JOIN file.workspace_usage uu ON uu.workspace_id = w.id
  LEFT JOIN file.workspace_limits l ON l.workspace_id = w.id
 WHERE w.status <> 'DELETED'
   AND (p_workspace_id IS NULL OR w.id = p_workspace_id)
 ORDER BY w.created_at DESC, w.id DESC
$$;

REVOKE ALL ON FUNCTION ops.admin_users_page(text, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.admin_chats_page(uuid, text, text, integer, timestamptz, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.admin_storage_workspaces(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ops.admin_users_page(text, integer, timestamptz, uuid) TO krug_app;
GRANT EXECUTE ON FUNCTION ops.admin_chats_page(uuid, text, text, integer, timestamptz, uuid)
  TO krug_app;
GRANT EXECUTE ON FUNCTION ops.admin_storage_workspaces(uuid) TO krug_app;

COMMENT ON FUNCTION ops.admin_users_page(text, integer, timestamptz, uuid) IS
  'E9-B platform-admin user page: metadata + aggregate counts, no content (cursor: created_at,id)';
COMMENT ON FUNCTION ops.admin_chats_page(uuid, text, text, integer, timestamptz, uuid) IS
  'E9-B platform-admin chat page: metadata only, messages_count = chat_counters.next_seq-1';
COMMENT ON FUNCTION ops.admin_storage_workspaces(uuid) IS
  'E9-B platform-admin storage rows: quota aggregates + attachment/object counts, no keys/content';
