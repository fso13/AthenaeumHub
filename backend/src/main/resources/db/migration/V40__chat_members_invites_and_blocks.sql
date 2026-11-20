-- P0-1 / GitHub #79: channel member management, invite links and user blocks.
--
-- Additive only:
--   * chat.invites — invite links for GROUP channels. Only the SHA-256 hex digest of the
--     opaque token is stored; the raw token is returned once by POST /chats/{id}/invites and
--     is not recoverable afterwards. Expiry, optional max_uses and the invite role live here.
--   * auth.user_blocks — self-scoped user blocks (global per user, not per tenant). The
--     table replaces no existing one and does not touch auth.users/devices policies.
--   * chat.member_directory(...) — narrow read-only SECURITY DEFINER lookup for display
--     names. auth.users is FORCE RLS with a self-only policy (V2), so a plain runtime query
--     cannot join other members' display names. The function mirrors V24
--     workspace.member_directory: it returns only the contract fields, verifies that the
--     caller (ops.current_user_id()) is an ACTIVE member of the chat's ACTIVE workspace, and
--     grants EXECUTE to krug_app only.
--   * chat.accept_invite(...) — the invite token is global (the accept URL has no workspace),
--     so the lookup and join must run inside a narrow SECURITY DEFINER function. It verifies
--     the caller, locks the invite row (FOR UPDATE) so max_uses is enforced atomically, and
--     never returns the token/hash.
--   * auth.set_user_block(...) — block/unblock runs in one function so the target existence
--     check does not require reading auth.users under RLS.
--
-- No existing table, column, policy or grant is changed; RLS is not weakened anywhere.
--
-- The SECURITY DEFINER functions run as their owner and must be able to read the
-- FORCE-RLS tables they join (auth.users, workspace.memberships, chat.*) exactly like
-- V24 workspace.member_directory and V27 workspace.* functions: the migration role is
-- superuser/BYPASSRLS in dev/test, and production DBAs provision the same split. They still
-- re-check ops.current_user_id() and the caller's ACTIVE membership, so a caller who
-- bypasses the HTTP guard gets no rows / no join.

-- ---------------------------------------------------------------------------------
-- Invite links.
-- ---------------------------------------------------------------------------------
CREATE TABLE chat.invites (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  -- SHA-256 hex of the opaque token; the raw token never reaches the database.
  token_hash   text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  -- OWNER is intentionally not assignable through an invite link.
  role         text NOT NULL CHECK (role IN ('ADMIN', 'MODERATOR', 'MEMBER', 'GUEST')),
  created_by   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  max_uses     integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000),
  used_count   integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invites_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_invites_uses CHECK (max_uses IS NULL OR used_count <= max_uses)
);

CREATE INDEX ix_invites_chat_created ON chat.invites (chat_id, created_at DESC);
CREATE INDEX ix_invites_ws_expiry ON chat.invites (workspace_id, expires_at);

ALTER TABLE chat.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.invites FORCE ROW LEVEL SECURITY;
CREATE POLICY p_invites_tenant ON chat.invites
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON chat.invites TO krug_app;

COMMENT ON TABLE chat.invites IS
  'GROUP channel invite links (#79); token_hash only, raw token is never persisted.';
COMMENT ON COLUMN chat.invites.token_hash IS
  'SHA-256 hex of the opaque invite token; never exposed through the API.';

-- Owner counts and the member directory filter on (chat_id, role) for ACTIVE rows.
CREATE INDEX ix_chat_members_chat_role
  ON chat.chat_members (chat_id, role)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------------
-- Member directory with display names (read-only, caller-membership checked).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chat.member_directory(p_chat_id uuid, p_user_id uuid)
  RETURNS TABLE (
    user_id uuid,
    display_name text,
    role text,
    status text,
    joined_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT u.id,
       u.display_name,
       cm.role,
       cm.status,
       cm.joined_at
  FROM chat.chat_members caller
  JOIN chat.chat_members cm
    ON cm.chat_id = caller.chat_id
   AND cm.status = 'ACTIVE'
  JOIN chat.chats c
    ON c.id = caller.chat_id
   AND c.deleted_at IS NULL
  JOIN workspace.memberships wm
    ON wm.workspace_id = c.workspace_id
   AND wm.user_id = caller.user_id
   AND wm.status = 'ACTIVE'
  JOIN workspace.workspaces w
    ON w.id = c.workspace_id
   AND w.status = 'ACTIVE'
  JOIN auth.users u
    ON u.id = cm.user_id
 WHERE caller.chat_id = p_chat_id
   AND caller.user_id = p_user_id
   AND caller.status = 'ACTIVE'
   AND p_user_id = ops.current_user_id()
 ORDER BY u.display_name ASC, u.id ASC
 LIMIT 1000
$$;

REVOKE ALL ON FUNCTION chat.member_directory(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat.member_directory(uuid, uuid) TO krug_app;

COMMENT ON FUNCTION chat.member_directory(uuid, uuid) IS
  '#79 ACTIVE chat members with display_name for an ACTIVE chat member of an ACTIVE workspace; no email/device/key data';

-- ---------------------------------------------------------------------------------
-- Accept an invite (token lookup + join) for the authenticated caller.
--
-- Outcome strings (mapped to HTTP by the chat application layer):
--   OK               — joined or already an ACTIVE member (already_member = true);
--   NOT_FOUND        — unknown token hash (404, existence is not disclosed);
--   FORBIDDEN        — caller is not an ACTIVE member of the invite workspace (403);
--   CHAT_UNAVAILABLE — chat is deleted or no longer a GROUP chat (404);
--   REVOKED          — invite was revoked (410);
--   EXPIRED          — expires_at passed (410);
--   EXHAUSTED        — max_uses reached (410).
--
-- An existing ACTIVE member is answered before expiry/revocation so a repeated accept is
-- truly idempotent; used_count is not incremented and the application skips the audit.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chat.accept_invite(p_token_hash text, p_user_id uuid)
  RETURNS TABLE (
    outcome text,
    invite_id uuid,
    workspace_id uuid,
    chat_id uuid,
    role text,
    already_member boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_invite chat.invites%ROWTYPE;
  v_chat_type text;
  v_chat_deleted_at timestamptz;
  v_member_status text;
  v_member_role text;
BEGIN
  IF p_user_id IS DISTINCT FROM ops.current_user_id() THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text, false;
    RETURN;
  END IF;

  -- FOR UPDATE serializes concurrent accepts of the same link, so max_uses is exact.
  SELECT *
    INTO v_invite
    FROM chat.invites
   WHERE token_hash = p_token_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text, false;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM workspace.memberships m
      JOIN workspace.workspaces w
        ON w.id = m.workspace_id
       AND w.status = 'ACTIVE'
     WHERE m.workspace_id = v_invite.workspace_id
       AND m.user_id = p_user_id
       AND m.status = 'ACTIVE'
  ) THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, v_invite.workspace_id, NULL::uuid,
                        NULL::text, false;
    RETURN;
  END IF;

  SELECT c.type, c.deleted_at
    INTO v_chat_type, v_chat_deleted_at
    FROM chat.chats c
   WHERE c.id = v_invite.chat_id;

  IF NOT FOUND OR v_chat_deleted_at IS NOT NULL OR v_chat_type <> 'GROUP' THEN
    RETURN QUERY SELECT 'CHAT_UNAVAILABLE'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.chat_id, NULL::text, false;
    RETURN;
  END IF;

  SELECT cm.status, cm.role
    INTO v_member_status, v_member_role
    FROM chat.chat_members cm
   WHERE cm.chat_id = v_invite.chat_id
     AND cm.user_id = p_user_id;

  IF v_member_status = 'ACTIVE' THEN
    RETURN QUERY SELECT 'OK'::text, v_invite.id, v_invite.workspace_id, v_invite.chat_id,
                        v_member_role, true;
    RETURN;
  END IF;

  IF v_invite.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'REVOKED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.chat_id, v_invite.role, false;
    RETURN;
  END IF;

  IF v_invite.expires_at <= now() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.chat_id, v_invite.role, false;
    RETURN;
  END IF;

  IF v_invite.max_uses IS NOT NULL AND v_invite.used_count >= v_invite.max_uses THEN
    RETURN QUERY SELECT 'EXHAUSTED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.chat_id, v_invite.role, false;
    RETURN;
  END IF;

  INSERT INTO chat.chat_members
      (chat_id, workspace_id, user_id, role, status, joined_at, updated_at)
  VALUES (v_invite.chat_id, v_invite.workspace_id, p_user_id, v_invite.role, 'ACTIVE',
          now(), now())
  -- The constraint name is used because RETURNS TABLE exposes chat_id/user_id as
  -- PL/pgSQL variables, which would make a bare (chat_id, user_id) target ambiguous.
  ON CONFLICT ON CONSTRAINT chat_members_pkey DO UPDATE
     SET role = EXCLUDED.role,
         status = 'ACTIVE',
         joined_at = EXCLUDED.joined_at,
         updated_at = now();

  UPDATE chat.invites
     SET used_count = used_count + 1
   WHERE id = v_invite.id;

  RETURN QUERY SELECT 'OK'::text, v_invite.id, v_invite.workspace_id, v_invite.chat_id,
                      v_invite.role, false;
END
$$;

REVOKE ALL ON FUNCTION chat.accept_invite(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat.accept_invite(text, uuid) TO krug_app;

COMMENT ON FUNCTION chat.accept_invite(text, uuid) IS
  '#79 join a GROUP channel by invite token hash: caller/workspace checks, row lock for max_uses, idempotent for existing ACTIVE members';

-- ---------------------------------------------------------------------------------
-- User blocks (global per user, self-scoped like auth.users).
-- ---------------------------------------------------------------------------------
CREATE TABLE auth.user_blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT ck_user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX ix_user_blocks_blocker_created
  ON auth.user_blocks (blocker_id, created_at DESC);

ALTER TABLE auth.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.user_blocks FORCE ROW LEVEL SECURITY;
-- A user sees and writes only their own block list. No cross-user read path and no
-- workspace dimension: blocks are identity-scoped, exactly like auth.users (V2).
CREATE POLICY p_user_blocks_self ON auth.user_blocks
  USING (blocker_id = ops.current_user_id())
  WITH CHECK (blocker_id = ops.current_user_id() AND blocker_id <> blocked_id);

GRANT SELECT, INSERT, DELETE ON auth.user_blocks TO krug_app;

COMMENT ON TABLE auth.user_blocks IS
  '#79 self-scoped blocks between users; no workspace_id, no email/display exposure.';

CREATE OR REPLACE FUNCTION auth.set_user_block(
    p_blocker_id uuid,
    p_blocked_id uuid,
    p_blocked boolean)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF p_blocker_id IS DISTINCT FROM ops.current_user_id() THEN
    RETURN 'FORBIDDEN';
  END IF;

  IF p_blocked_id = p_blocker_id THEN
    RETURN 'SELF';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM auth.users u
     WHERE u.id = p_blocked_id
       AND u.status = 'ACTIVE'
  ) THEN
    RETURN 'USER_NOT_FOUND';
  END IF;

  IF p_blocked THEN
    IF EXISTS (
      SELECT 1
        FROM auth.user_blocks b
       WHERE b.blocker_id = p_blocker_id
         AND b.blocked_id = p_blocked_id
    ) THEN
      RETURN 'UNCHANGED';
    END IF;
    INSERT INTO auth.user_blocks (blocker_id, blocked_id)
    VALUES (p_blocker_id, p_blocked_id);
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM auth.user_blocks b
       WHERE b.blocker_id = p_blocker_id
         AND b.blocked_id = p_blocked_id
    ) THEN
      RETURN 'UNCHANGED';
    END IF;
    DELETE FROM auth.user_blocks b
     WHERE b.blocker_id = p_blocker_id
       AND b.blocked_id = p_blocked_id;
  END IF;

  RETURN 'OK';
END
$$;

REVOKE ALL ON FUNCTION auth.set_user_block(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.set_user_block(uuid, uuid, boolean) TO krug_app;

COMMENT ON FUNCTION auth.set_user_block(uuid, uuid, boolean) IS
  '#79 idempotent block/unblock for the authenticated caller; returns OK/UNCHANGED/SELF/USER_NOT_FOUND/FORBIDDEN';

-- Forward-only rollback plan:
--   DROP FUNCTION chat.accept_invite(text, uuid);
--   DROP FUNCTION chat.member_directory(uuid, uuid);
--   DROP FUNCTION auth.set_user_block(uuid, uuid, boolean);
--   DROP TABLE auth.user_blocks;
--   DROP TABLE chat.invites;
--   DROP INDEX chat.ix_chat_members_chat_role;
-- Invite rows, blocks and their audit trail references are lost on rollback; chats,
-- chat_members, messages and V39 visibility data are untouched.
