-- E12-B: workspace member management (R-09, FR-WS-4…FR-WS-7).
--
-- auth.users is FORCE RLS with a self-only policy (V2), so an OWNER/ADMIN cannot resolve
-- a future member by email through the runtime role. Exactly like V24, the lookup and the
-- mutation run inside narrow SECURITY DEFINER functions owned by the migration role
-- (superuser/BYPASSRLS in dev/test; production DBAs provision the same split as for
-- ops.platform_overview(), V23 and V24).
--
-- Why every operation is one function:
--   * the actor role check, duplicate check, member-limit check, INSERT/UPDATE and the
--     returned row are one SQL statement, so they share one transaction and one lock;
--   * membership changes are serialized per workspace with a transaction-scoped advisory
--     lock, therefore two concurrent adds cannot both pass count(*) < max_workspace_members;
--   * the limit is read from the ops.system_settings singleton inside the same transaction,
--     never from a stale application cache;
--   * a caller who bypasses the HTTP guard still gets FORBIDDEN, because the function
--     re-checks `p_actor_id = ops.current_user_id()` and an ACTIVE OWNER/ADMIN membership.
--
-- Outcome strings (mapped to HTTP by the workspace application layer):
--   OK                    — mutation committed;
--   FORBIDDEN             — caller is not an ACTIVE OWNER/ADMIN of an ACTIVE workspace;
--   ROLE_FORBIDDEN        — caller may not assign/change this role (OWNER is never
--                           assignable, ADMIN cannot manage ADMIN/OWNER);
--   ROLE_INVALID          — unknown role literal (defence in depth; API validates first);
--   USER_NOT_FOUND        — no ACTIVE account with that email (404);
--   MEMBER_NOT_FOUND      — no ACTIVE membership for the target user (404);
--   ALREADY_EXISTS        — any membership row already exists, including REMOVED (409);
--   LIMIT_REACHED         — ACTIVE member count reached max_workspace_members (409);
--   SELF                  — caller may not change/remove their own non-OWNER membership (409);
--   LAST_OWNER            — the last ACTIVE OWNER cannot be demoted or removed (409).
--
-- Audit is appended by the application in the same transaction through AuditPort, with
-- user ids and roles only (no email, display name or content).

-- ---------------------------------------------------------------------------------
-- Add an existing ACTIVE user by email.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.add_member(
    p_workspace_id uuid,
    p_actor_id uuid,
    p_email text,
    p_role text)
  RETURNS TABLE (
    outcome text,
    user_id uuid,
    display_name text,
    role text,
    joined_at timestamptz,
    members_used integer,
    members_limit integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_workspace_status text;
  v_actor_role text;
  v_user_id uuid;
  v_display_name text;
  v_used integer;
  v_limit integer;
  v_joined_at timestamptz;
BEGIN
  IF p_role NOT IN ('ADMIN', 'MEMBER', 'GUEST') THEN
    -- OWNER is never assignable: the workspace has exactly one owner (V2 unique index).
    RETURN QUERY SELECT 'ROLE_FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  -- Serializes add/role/remove for this workspace. READ COMMITTED then sees the previous
  -- mutation's committed row, which makes the limit check atomic.
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace.members|' || p_workspace_id::text, 0));

  SELECT w.status
    INTO v_workspace_status
    FROM workspace.workspaces w
   WHERE w.id = p_workspace_id;

  IF NOT FOUND OR v_workspace_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  SELECT m.role
    INTO v_actor_role
    FROM workspace.memberships m
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_actor_id
     AND m.status = 'ACTIVE'
     AND p_actor_id = ops.current_user_id();

  IF NOT FOUND OR v_actor_role NOT IN ('OWNER', 'ADMIN') THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  IF v_actor_role = 'ADMIN' AND p_role IN ('ADMIN', 'OWNER') THEN
    RETURN QUERY SELECT 'ROLE_FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  SELECT u.id, u.display_name
    INTO v_user_id, v_display_name
    FROM auth.users u
   WHERE lower(u.email) = lower(btrim(p_email))
     AND u.status = 'ACTIVE'
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'USER_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  -- Any row, including REMOVED/INVITED, is a duplicate: re-adding is an explicit 409 and
  -- never silently resurrects a previous membership.
  IF EXISTS (SELECT 1
               FROM workspace.memberships m
              WHERE m.workspace_id = p_workspace_id
                AND m.user_id = v_user_id) THEN
    RETURN QUERY SELECT 'ALREADY_EXISTS'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  SELECT s.max_workspace_members
    INTO v_limit
    FROM ops.system_settings s
   WHERE s.id = 1;

  SELECT count(*)::integer
    INTO v_used
    FROM workspace.memberships m
   WHERE m.workspace_id = p_workspace_id
     AND m.status = 'ACTIVE';

  IF v_used >= v_limit THEN
    RETURN QUERY SELECT 'LIMIT_REACHED'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, v_used, v_limit;
    RETURN;
  END IF;

  v_joined_at := now();

  INSERT INTO workspace.memberships (workspace_id, user_id, role, status, joined_at,
                                     updated_at)
  VALUES (p_workspace_id, v_user_id, p_role, 'ACTIVE', v_joined_at, v_joined_at);

  RETURN QUERY SELECT 'OK'::text, v_user_id, v_display_name, p_role, v_joined_at,
                      v_used + 1, v_limit;
END
$$;

-- ---------------------------------------------------------------------------------
-- Change one member's role.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.change_member_role(
    p_workspace_id uuid,
    p_actor_id uuid,
    p_target_user_id uuid,
    p_role text)
  RETURNS TABLE (
    outcome text,
    user_id uuid,
    display_name text,
    role text,
    previous_role text,
    joined_at timestamptz)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_workspace_status text;
  v_actor_role text;
  v_target_role text;
  v_display_name text;
  v_joined_at timestamptz;
  v_owners integer;
BEGIN
  IF p_role NOT IN ('OWNER', 'ADMIN', 'MEMBER', 'GUEST') THEN
    RETURN QUERY SELECT 'ROLE_INVALID'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workspace.members|' || p_workspace_id::text, 0));

  SELECT w.status
    INTO v_workspace_status
    FROM workspace.workspaces w
   WHERE w.id = p_workspace_id;

  IF NOT FOUND OR v_workspace_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT m.role
    INTO v_actor_role
    FROM workspace.memberships m
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_actor_id
     AND m.status = 'ACTIVE'
     AND p_actor_id = ops.current_user_id();

  IF NOT FOUND OR v_actor_role NOT IN ('OWNER', 'ADMIN') THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT m.role, u.display_name, m.joined_at
    INTO v_target_role, v_display_name, v_joined_at
    FROM workspace.memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_target_user_id
     AND m.status = 'ACTIVE';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'MEMBER_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_actor_role = 'ADMIN' THEN
    IF p_target_user_id = p_actor_id THEN
      RETURN QUERY SELECT 'SELF'::text, p_target_user_id, v_display_name, v_target_role,
                          v_target_role, v_joined_at;
      RETURN;
    END IF;
    IF v_target_role IN ('OWNER', 'ADMIN') OR p_role IN ('OWNER', 'ADMIN') THEN
      RETURN QUERY SELECT 'ROLE_FORBIDDEN'::text, p_target_user_id, v_display_name,
                          v_target_role, v_target_role, v_joined_at;
      RETURN;
    END IF;
  ELSE
    -- OWNER: OWNER is immutable/never assignable; the last OWNER cannot be demoted.
    IF p_role = 'OWNER' THEN
      RETURN QUERY SELECT 'ROLE_FORBIDDEN'::text, p_target_user_id, v_display_name,
                          v_target_role, v_target_role, v_joined_at;
      RETURN;
    END IF;
    IF v_target_role = 'OWNER' THEN
      SELECT count(*)::integer
        INTO v_owners
        FROM workspace.memberships m
       WHERE m.workspace_id = p_workspace_id
         AND m.role = 'OWNER'
         AND m.status = 'ACTIVE';
      IF v_owners <= 1 THEN
        RETURN QUERY SELECT 'LAST_OWNER'::text, p_target_user_id, v_display_name,
                            v_target_role, v_target_role, v_joined_at;
        RETURN;
      END IF;
    END IF;
    IF p_target_user_id = p_actor_id THEN
      RETURN QUERY SELECT 'SELF'::text, p_target_user_id, v_display_name, v_target_role,
                          v_target_role, v_joined_at;
      RETURN;
    END IF;
  END IF;

  IF v_target_role <> p_role THEN
    UPDATE workspace.memberships AS m
       SET role = p_role,
           updated_at = now()
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = p_target_user_id;
  END IF;

  RETURN QUERY SELECT 'OK'::text, p_target_user_id, v_display_name, p_role,
                      v_target_role, v_joined_at;
END
$$;

-- ---------------------------------------------------------------------------------
-- Remove one member (soft: status = REMOVED; the row and joined_at are kept).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.remove_member(
    p_workspace_id uuid,
    p_actor_id uuid,
    p_target_user_id uuid)
  RETURNS TABLE (
    outcome text,
    user_id uuid,
    display_name text,
    role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_workspace_status text;
  v_actor_role text;
  v_target_role text;
  v_display_name text;
  v_owners integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace.members|' || p_workspace_id::text, 0));

  SELECT w.status
    INTO v_workspace_status
    FROM workspace.workspaces w
   WHERE w.id = p_workspace_id;

  IF NOT FOUND OR v_workspace_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT m.role
    INTO v_actor_role
    FROM workspace.memberships m
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_actor_id
     AND m.status = 'ACTIVE'
     AND p_actor_id = ops.current_user_id();

  IF NOT FOUND OR v_actor_role NOT IN ('OWNER', 'ADMIN') THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT m.role, u.display_name
    INTO v_target_role, v_display_name
    FROM workspace.memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_target_user_id
     AND m.status = 'ACTIVE';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'MEMBER_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_actor_role = 'ADMIN' THEN
    IF p_target_user_id = p_actor_id THEN
      RETURN QUERY SELECT 'SELF'::text, p_target_user_id, v_display_name, v_target_role;
      RETURN;
    END IF;
    IF v_target_role IN ('OWNER', 'ADMIN') THEN
      RETURN QUERY SELECT 'ROLE_FORBIDDEN'::text, p_target_user_id, v_display_name,
                          v_target_role;
      RETURN;
    END IF;
  ELSE
    IF v_target_role = 'OWNER' THEN
      SELECT count(*)::integer
        INTO v_owners
        FROM workspace.memberships m
       WHERE m.workspace_id = p_workspace_id
         AND m.role = 'OWNER'
         AND m.status = 'ACTIVE';
      IF v_owners <= 1 THEN
        RETURN QUERY SELECT 'LAST_OWNER'::text, p_target_user_id, v_display_name,
                            v_target_role;
        RETURN;
      END IF;
    END IF;
    IF p_target_user_id = p_actor_id THEN
      RETURN QUERY SELECT 'SELF'::text, p_target_user_id, v_display_name, v_target_role;
      RETURN;
    END IF;
  END IF;

  UPDATE workspace.memberships AS m
     SET status = 'REMOVED',
         updated_at = now()
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_target_user_id;

  RETURN QUERY SELECT 'OK'::text, p_target_user_id, v_display_name, v_target_role;
END
$$;

REVOKE ALL ON FUNCTION workspace.add_member(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace.change_member_role(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace.remove_member(uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION workspace.add_member(uuid, uuid, text, text) TO krug_app;
GRANT EXECUTE ON FUNCTION workspace.change_member_role(uuid, uuid, uuid, text) TO krug_app;
GRANT EXECUTE ON FUNCTION workspace.remove_member(uuid, uuid, uuid) TO krug_app;

COMMENT ON FUNCTION workspace.add_member(uuid, uuid, text, text) IS
  'E12-B add an existing ACTIVE user by email: actor OWNER/ADMIN, atomic member limit, no OWNER assignment, no email in the result';
COMMENT ON FUNCTION workspace.change_member_role(uuid, uuid, uuid, text) IS
  'E12-B role change: actor OWNER/ADMIN, ADMIN cannot touch ADMIN/OWNER, OWNER is immutable and the last OWNER is protected';
COMMENT ON FUNCTION workspace.remove_member(uuid, uuid, uuid) IS
  'E12-B soft-remove a member (status=REMOVED): last OWNER and self are protected, access is re-checked on the next request';
