-- E11-B: platform-admin actions (suspend/activate user, soft-delete chat) and the
-- cross-tenant audit-log view (R-08, FR-ADM-15…FR-ADM-18).
--
-- Why SECURITY DEFINER: the platform admin authenticates as a normal user. auth.users is
-- FORCE RLS with a self-only policy (V2) and chat.chats/audit.audit_events carry tenant
-- policies, so a plain runtime query would only see the admin's own rows. Every operation
-- below therefore goes through one narrow SECURITY DEFINER function owned by the
-- migration role (superuser/BYPASSRLS in dev/test; a DBA splits the roles the same way in
-- production, exactly like ops.platform_overview() and V23).
--
-- Invariants kept by this migration:
--   * no physical DELETE of messages/files/chats: chat soft-delete only sets deleted_at;
--   * the audit hash chain is untouched: audit.audit_events stays append-only and the
--     application appends through AuditPort (no UPDATE/DELETE is granted here);
--   * the functions return metadata/counts only — never message text, E2EE envelopes,
--     file names/object keys or secrets;
--   * EXECUTE is granted to krug_app only, never PUBLIC;
--   * user suspension is serialized with the same advisory lock as the single-admin claim,
--     so the "last platform admin" backstop is atomic even under concurrency.

-- Keyset support for the audit view (created_at DESC, id DESC). The V6 indexes are
-- workspace/actor-scoped, not global.
CREATE INDEX IF NOT EXISTS ix_audit_events_created_at_id
  ON audit.audit_events (created_at DESC, id DESC);

-- One user row for the admin action pre-check (404/409 decision before touching Keycloak).
CREATE OR REPLACE FUNCTION ops.admin_user_detail(p_user_id uuid)
  RETURNS TABLE (
    id uuid,
    email text,
    display_name text,
    status text,
    is_platform_admin boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT u.id,
       u.email::text,
       u.display_name,
       u.status,
       u.is_platform_admin
  FROM auth.users u
 WHERE u.id = p_user_id
   AND u.status <> 'DELETED'
$$;

-- Suspend/activate one user. Returns an outcome instead of raising, so the application can
-- map NOT_FOUND -> 404, ALREADY -> 409 and LAST_ADMIN -> 409 without parsing SQLSTATE.
-- ACTIVE is the only status this endpoint may assign; DELETED stays out of reach.
CREATE OR REPLACE FUNCTION ops.admin_set_user_status(p_user_id uuid, p_status text)
  RETURNS TABLE (
    outcome text,
    id uuid,
    status text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_status text;
  v_platform_admin boolean;
  v_admin_count integer;
BEGIN
  IF p_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'unsupported target status';
  END IF;

  -- Same lock as auth.claim_platform_admin(): the admin-count check and the UPDATE are one
  -- atomic step, so two concurrent suspensions can never remove the last admin.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.users.platform_admin', 0));

  SELECT u.status, u.is_platform_admin
    INTO v_status, v_platform_admin
    FROM auth.users u
   WHERE u.id = p_user_id
     AND u.status <> 'DELETED';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, p_user_id, NULL::text;
    RETURN;
  END IF;

  IF v_status = p_status THEN
    RETURN QUERY SELECT 'ALREADY'::text, p_user_id, v_status;
    RETURN;
  END IF;

  IF p_status = 'SUSPENDED' AND v_platform_admin THEN
    SELECT count(*) INTO v_admin_count FROM auth.users WHERE is_platform_admin;
    IF v_admin_count <= 1 THEN
      RETURN QUERY SELECT 'LAST_ADMIN'::text, p_user_id, v_status;
      RETURN;
    END IF;
  END IF;

  UPDATE auth.users AS u
     SET status = p_status,
         updated_at = now()
   WHERE u.id = p_user_id;

  RETURN QUERY SELECT 'OK'::text, p_user_id, p_status;
END
$$;

-- Soft-delete one chat: sets deleted_at, keeps chat_members/messages/files untouched.
-- Lists and message access already filter c.chat_id/deleted_at IS NULL, so the chat
-- disappears for participants without a destructive delete.
CREATE OR REPLACE FUNCTION ops.admin_soft_delete_chat(p_chat_id uuid)
  RETURNS TABLE (
    outcome text,
    workspace_id uuid,
    members_count bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_workspace_id uuid;
  v_deleted_at timestamptz;
  v_members bigint;
BEGIN
  SELECT c.workspace_id, c.deleted_at
    INTO v_workspace_id, v_deleted_at
    FROM chat.chats c
   WHERE c.id = p_chat_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, 0::bigint;
    RETURN;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'ALREADY_DELETED'::text, v_workspace_id, 0::bigint;
    RETURN;
  END IF;

  UPDATE chat.chats AS c
     SET deleted_at = now(),
         updated_at = now()
   WHERE c.id = p_chat_id;

  SELECT count(*) INTO v_members
    FROM chat.chat_members cm
   WHERE cm.chat_id = p_chat_id
     AND cm.status = 'ACTIVE';

  RETURN QUERY SELECT 'OK'::text, v_workspace_id, v_members;
END
$$;

-- Cross-tenant audit page. Only the columns of the AdminAuditEvent contract are returned:
-- the metadata JSONB (which may hold counts and other non-secret details) and hashes never
-- leave the database through this function. actor_email is the single PII field and is
-- explicitly allowed by the admin audit contract; it is never joined with content tables.
CREATE OR REPLACE FUNCTION ops.admin_audit_page(
    p_action text,
    p_limit integer,
    p_cursor_created_at timestamptz,
    p_cursor_id uuid)
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
   AND (p_cursor_created_at IS NULL
        OR (e.created_at, e.id) < (p_cursor_created_at, p_cursor_id))
 ORDER BY e.created_at DESC, e.id DESC
 LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;

REVOKE ALL ON FUNCTION ops.admin_user_detail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.admin_set_user_status(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.admin_soft_delete_chat(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.admin_audit_page(text, integer, timestamptz, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ops.admin_user_detail(uuid) TO krug_app;
GRANT EXECUTE ON FUNCTION ops.admin_set_user_status(uuid, text) TO krug_app;
GRANT EXECUTE ON FUNCTION ops.admin_soft_delete_chat(uuid) TO krug_app;
GRANT EXECUTE ON FUNCTION ops.admin_audit_page(text, integer, timestamptz, uuid) TO krug_app;

COMMENT ON FUNCTION ops.admin_user_detail(uuid) IS
  'E11-B platform-admin user pre-check: metadata only, DELETED rows excluded';
COMMENT ON FUNCTION ops.admin_set_user_status(uuid, text) IS
  'E11-B suspend/activate with an atomic last-platform-admin backstop (no physical delete)';
COMMENT ON FUNCTION ops.admin_soft_delete_chat(uuid) IS
  'E11-B chat soft-delete: sets deleted_at, messages/files/members are kept';
COMMENT ON FUNCTION ops.admin_audit_page(text, integer, timestamptz, uuid) IS
  'E11-B cross-tenant audit page: contract columns only, metadata/hashes never returned';
