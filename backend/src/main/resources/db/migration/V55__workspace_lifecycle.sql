-- #99: workspace lifecycle — self-leave and owner soft-delete.
--
-- Both operations are exactly one SECURITY DEFINER call, so the actor check, the
-- last-owner check, the write and the returned counters share one transaction and one
-- per-workspace advisory lock (the same key as V27 add/role/remove). auth.users is FORCE
-- RLS and the runtime role cannot traverse every membership of the workspace otherwise;
-- the function is owned by the migration role exactly like V24/V27/V42/V43.
--
-- Outcomes (mapped to HTTP by the workspace application layer):
--   OK                — the mutation committed;
--   ALREADY_LEFT      — the caller's membership is already REMOVED (idempotent 204);
--   ALREADY_DELETED   — the workspace is already soft-deleted (idempotent 204 for the
--                       owner; another caller gets FORBIDDEN and cannot probe the state);
--   FORBIDDEN         — missing workspace, no membership row, non-active membership, or a
--                       non-owner replay of a deleted workspace;
--   NOT_OWNER         — an ACTIVE member that is not the OWNER (403, delete only);
--   LAST_OWNER        — the last ACTIVE OWNER cannot leave (409; leave only).
--
-- Deletion is soft and content-preserving:
--   * workspace.workspaces.status = 'DELETED', deleted_at/deleted_by are set;
--   * every membership becomes REMOVED, every invite gets revoked_at, every chat
--     participant row becomes REMOVED and every bot of the workspace becomes DISABLED;
--   * chat rows, message rows, attachment rows and object-storage bytes are deliberately
--     untouched: history stays available to the future retention/export job and no blob is
--     hard-deleted here. API access is gone because every workspace guard requires an
--     ACTIVE membership (and chat access additionally requires it).
--
-- Leave removes the caller's membership and their chat participant rows, so the exact
-- chat member_count drops immediately and a later re-add cannot resurrect hidden access.
-- Existing stateless access tokens are not revoked globally (that would log the user out
-- of every workspace); authorization is re-evaluated on the next request.

ALTER TABLE workspace.workspaces
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_workspaces_status
  ON workspace.workspaces (status);

COMMENT ON COLUMN workspace.workspaces.deleted_at IS
  '#99 soft-delete timestamp set together with status=DELETED; content is retained for the retention job';
COMMENT ON COLUMN workspace.workspaces.deleted_by IS
  '#99 OWNER that soft-deleted the workspace; never a content field';

-- ---------------------------------------------------------------------------------
-- Leave one workspace (self only).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.leave_workspace(
    p_workspace_id uuid,
    p_actor_id uuid)
  RETURNS TABLE (
    outcome text,
    role text,
    chat_memberships_removed integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_workspace_status text;
  v_member_status text;
  v_role text;
  v_owners integer;
  v_chat_memberships integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace.members|' || p_workspace_id::text, 0));

  SELECT w.status
    INTO v_workspace_status
    FROM workspace.workspaces w
   WHERE w.id = p_workspace_id;

  IF NOT FOUND THEN
    -- Unknown and foreign workspaces are indistinguishable: never disclose existence.
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::text, 0;
    RETURN;
  END IF;

  SELECT m.status, m.role
    INTO v_member_status, v_role
    FROM workspace.memberships m
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_actor_id
     AND p_actor_id = ops.current_user_id();

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::text, 0;
    RETURN;
  END IF;

  -- A member who was removed by an administrator (or who already left) gets the same
  -- idempotent 204 and no audit noise.
  IF v_member_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'ALREADY_LEFT'::text, v_role, 0;
    RETURN;
  END IF;

  -- The last ACTIVE OWNER cannot orphan the workspace. V2's ux_memberships_one_owner
  -- currently allows exactly one OWNER, so this always answers LAST_OWNER today; the
  -- count keeps the rule correct if co-owners are ever introduced.
  IF v_role = 'OWNER' THEN
    SELECT count(*)::integer
      INTO v_owners
      FROM workspace.memberships m
     WHERE m.workspace_id = p_workspace_id
       AND m.role = 'OWNER'
       AND m.status = 'ACTIVE';
    IF v_owners <= 1 THEN
      RETURN QUERY SELECT 'LAST_OWNER'::text, v_role, 0;
      RETURN;
    END IF;
  END IF;

  UPDATE workspace.memberships AS m
     SET status = 'REMOVED',
         updated_at = now()
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_actor_id
     AND m.status = 'ACTIVE';

  -- The chat's own workspace is authoritative; a mismatched denormalized workspace_id
  -- cannot leave a participant row behind.
  UPDATE chat.chat_members AS cm
     SET status = 'REMOVED',
         updated_at = now()
    FROM chat.chats c
   WHERE c.id = cm.chat_id
     AND c.workspace_id = p_workspace_id
     AND cm.user_id = p_actor_id
     AND cm.status = 'ACTIVE';
  GET DIAGNOSTICS v_chat_memberships = ROW_COUNT;

  RETURN QUERY SELECT 'OK'::text, v_role, v_chat_memberships;
END
$$;

-- ---------------------------------------------------------------------------------
-- Soft-delete one workspace (OWNER only).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.delete_workspace(
    p_workspace_id uuid,
    p_actor_id uuid)
  RETURNS TABLE (
    outcome text,
    memberships_removed integer,
    invites_revoked integer,
    chat_memberships_removed integer,
    bots_disabled integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_workspace_status text;
  v_deleted_at timestamptz;
  v_created_by uuid;
  v_member_status text;
  v_role text;
  v_members integer := 0;
  v_invites integer := 0;
  v_chat_memberships integer := 0;
  v_bots integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace.members|' || p_workspace_id::text, 0));

  SELECT w.status, w.deleted_at, w.created_by
    INTO v_workspace_status, v_deleted_at, v_created_by
    FROM workspace.workspaces w
   WHERE w.id = p_workspace_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, 0, 0, 0, 0;
    RETURN;
  END IF;

  -- Replay of a completed deletion is a no-op 204 for the OWNER (or the creator), and an
  -- indistinguishable 403 for everybody else.
  IF v_workspace_status = 'DELETED' OR v_deleted_at IS NOT NULL THEN
    IF v_created_by = p_actor_id
        OR EXISTS (SELECT 1
                     FROM workspace.memberships m
                    WHERE m.workspace_id = p_workspace_id
                      AND m.user_id = p_actor_id
                      AND m.role = 'OWNER') THEN
      RETURN QUERY SELECT 'ALREADY_DELETED'::text, 0, 0, 0, 0;
    ELSE
      RETURN QUERY SELECT 'FORBIDDEN'::text, 0, 0, 0, 0;
    END IF;
    RETURN;
  END IF;

  SELECT m.status, m.role
    INTO v_member_status, v_role
    FROM workspace.memberships m
   WHERE m.workspace_id = p_workspace_id
     AND m.user_id = p_actor_id
     AND p_actor_id = ops.current_user_id();

  IF NOT FOUND OR v_member_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, 0, 0, 0, 0;
    RETURN;
  END IF;

  IF v_role <> 'OWNER' THEN
    RETURN QUERY SELECT 'NOT_OWNER'::text, 0, 0, 0, 0;
    RETURN;
  END IF;

  UPDATE workspace.workspaces AS w
     SET status = 'DELETED',
         deleted_at = now(),
         deleted_by = p_actor_id,
         updated_at = now()
   WHERE w.id = p_workspace_id
     AND w.status <> 'DELETED';

  UPDATE workspace.memberships AS m
     SET status = 'REMOVED',
         updated_at = now()
   WHERE m.workspace_id = p_workspace_id
     AND m.status <> 'REMOVED';
  GET DIAGNOSTICS v_members = ROW_COUNT;

  UPDATE workspace.invites AS i
     SET revoked_at = now()
   WHERE i.workspace_id = p_workspace_id
     AND i.revoked_at IS NULL;
  GET DIAGNOSTICS v_invites = ROW_COUNT;

  UPDATE chat.chat_members AS cm
     SET status = 'REMOVED',
         updated_at = now()
    FROM chat.chats c
   WHERE c.id = cm.chat_id
     AND c.workspace_id = p_workspace_id
     AND cm.status = 'ACTIVE';
  GET DIAGNOSTICS v_chat_memberships = ROW_COUNT;

  -- A live bot token must not keep writing into a deleted workspace. Bot rows are kept
  -- (the raw token is never stored) but authentication rejects a DISABLED bot.
  UPDATE bot.bots AS b
     SET status = 'DISABLED',
         updated_at = now()
   WHERE b.workspace_id = p_workspace_id
     AND b.status = 'ACTIVE';
  GET DIAGNOSTICS v_bots = ROW_COUNT;

  -- chat rows / messages / attachments / object bytes are intentionally untouched:
  -- a later retention job owns their eventual deletion (see the migration header).
  RETURN QUERY SELECT 'OK'::text, v_members, v_invites, v_chat_memberships, v_bots;
END
$$;

REVOKE ALL ON FUNCTION workspace.leave_workspace(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace.delete_workspace(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION workspace.leave_workspace(uuid, uuid) TO krug_app;
GRANT EXECUTE ON FUNCTION workspace.delete_workspace(uuid, uuid) TO krug_app;

COMMENT ON FUNCTION workspace.leave_workspace(uuid, uuid) IS
  '#99 self-leave: ACTIVE membership required, last OWNER protected, chat participant rows removed, idempotent for an already removed member';
COMMENT ON FUNCTION workspace.delete_workspace(uuid, uuid) IS
  '#99 OWNER soft-delete: status=DELETED + deleted_at, memberships/invites/chat participants removed, bots disabled, message/file blobs retained';
