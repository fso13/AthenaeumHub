-- E10-B: active workspace member directory for the DIRECT-chat peer picker.
--
-- auth.users is FORCE RLS with a self-only policy (V2), so a workspace member cannot join
-- other members' display names directly. This narrow SECURITY DEFINER function is the
-- same pattern as the V22/V23 cross-tenant reads: it is read-only, returns only the four
-- contract fields (no email, device or key data), and explicitly verifies that the caller
-- (ops.current_user_id()) has an ACTIVE membership in the requested workspace. A caller
-- who is not a member gets zero rows even if they bypass the application guard.
--
-- Keyset pagination is (display_name ASC, user_id ASC); search is a case-insensitive
-- literal substring (position(), never LIKE) over display_name. The application checks
-- membership first and maps a non-member to 403 without disclosing workspace existence.
--
-- The function owner must be able to read auth.users (the migration role is
-- superuser/BYPASSRLS in dev/test; production DBAs provision the same split). RLS and the
-- existing policies are not changed, and EXECUTE is granted to krug_app only.

-- Stable-order support for the (display_name, user_id) keyset. Partial on ACTIVE users:
-- the directory never returns suspended/deleted accounts.
CREATE INDEX IF NOT EXISTS ix_users_active_display_name_id
  ON auth.users (display_name, id)
  WHERE status = 'ACTIVE';

CREATE OR REPLACE FUNCTION workspace.member_directory(
    p_workspace_id uuid,
    p_query text,
    p_limit integer,
    p_cursor_display_name text,
    p_cursor_user_id uuid)
  RETURNS TABLE (
    user_id uuid,
    display_name text,
    role text,
    joined_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT u.id,
       u.display_name,
       m.role,
       m.joined_at
  FROM workspace.memberships caller
  JOIN workspace.memberships m
    ON m.workspace_id = caller.workspace_id
   AND m.status = 'ACTIVE'
  JOIN workspace.workspaces w
    ON w.id = m.workspace_id
   AND w.status = 'ACTIVE'
  JOIN auth.users u
    ON u.id = m.user_id
   AND u.status = 'ACTIVE'
 WHERE caller.workspace_id = p_workspace_id
   AND caller.user_id = ops.current_user_id()
   AND caller.status = 'ACTIVE'
   AND (p_query IS NULL
        OR position(lower(p_query) IN lower(u.display_name)) > 0)
   AND (p_cursor_display_name IS NULL
        OR (u.display_name, u.id) > (p_cursor_display_name, p_cursor_user_id))
 ORDER BY u.display_name ASC, u.id ASC
 LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;

REVOKE ALL ON FUNCTION workspace.member_directory(uuid, text, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.member_directory(uuid, text, integer, text, uuid)
  TO krug_app;

COMMENT ON FUNCTION workspace.member_directory(uuid, text, integer, text, uuid) IS
  'E10-B active workspace members for DIRECT chats: caller-membership checked, no email/keys, cursor (display_name,user_id)';
