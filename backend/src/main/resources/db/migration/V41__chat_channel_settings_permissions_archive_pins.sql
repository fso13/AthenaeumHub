-- P0-2 / GitHub #80: channel settings — cover, read-only, join policy, per-role permissions,
-- per-user archive, soft delete and pins.
--
-- Additive only. Nothing from V30 (name/description), V38 (participants) or V39 (visibility)
-- is altered, and no existing RLS policy/grant is weakened.
--
-- Design notes:
--   * cover_file_id references an existing CLEAN image attachment in file.attachments. There
--     is no new upload pipeline; ON DELETE SET NULL guarantees no dangling cover if the
--     attachment row is later physically removed. The reference is cleared on chat soft
--     delete by the application (see ChatDeletionService).
--   * read_only blocks chat.write (message send, poll creation) for everyone except the
--     channel OWNER/ADMIN (SYSTEM-ANALYSIS ABAC-10, 403 CHAT_READ_ONLY).
--   * join_policy is GROUP-only and independent of visibility. To keep the two settings
--     coherent the application enforces: visibility=PUBLIC => join_policy=OPEN. CLOSED
--     rejects new joins through an invite link (chat.accept_invite below); admin add still
--     works. Existing PUBLIC channels were workspace-wide, therefore OPEN after backfill.
--   * chat.chat_permissions stores the effective per-role matrix (6 permissions x 5 roles).
--     Only GROUP chats have rows; DIRECT chats keep no matrix (both participants can write).
--     The default rows are inserted by the application when a GROUP channel is created and
--     backfilled here for channels that already exist. A missing row is treated by the
--     application as the built-in default as a defensive fallback.
--   * chat.user_chat_archive is user-local UI state: (user_id, chat_id) PK, self-scoped RLS
--     (same pattern as auth.user_blocks) and a workspace dimension for tenant defence.
--   * chat.chat_pins mirrors ENT-20: PK(chat_id, message_id), (chat_id, pinned_at) index,
--     tenant RLS. message.messages is partitioned and cannot be an FK target by id alone, so
--     the application verifies that a pinned message exists in the same chat and is not
--     deleted before inserting the row. Pins store metadata only, never content.

-- ---------------------------------------------------------------------------------
-- Channel settings on the chat row.
-- ---------------------------------------------------------------------------------
-- read_only already exists in V3 (DEFAULT false); P0-2 starts using it and leaves its
-- definition untouched. Only the cover reference and the join policy are new columns.
ALTER TABLE chat.chats
  ADD COLUMN cover_file_id uuid,
  ADD COLUMN join_policy text NOT NULL DEFAULT 'INVITE_ONLY';

ALTER TABLE chat.chats
  ADD CONSTRAINT ck_chats_join_policy
    CHECK (join_policy IN ('OPEN', 'INVITE_ONLY', 'CLOSED')),
  ADD CONSTRAINT fk_chats_cover_file
    FOREIGN KEY (cover_file_id) REFERENCES file.attachments(id) ON DELETE SET NULL;

COMMENT ON COLUMN chat.chats.cover_file_id IS
  'P0-2 channel cover: CLEAN image attachment in the same chat; ON DELETE SET NULL.';
COMMENT ON COLUMN chat.chats.read_only IS
  'P0-2 read-only channel: only chat OWNER/ADMIN may write (403 CHAT_READ_ONLY).';
COMMENT ON COLUMN chat.chats.join_policy IS
  'P0-2 GROUP join policy: OPEN (workspace-wide), INVITE_ONLY (invite/add), CLOSED (add only).';

-- ---------------------------------------------------------------------------------
-- Per-role permission matrix (effective rows, defaults seeded on creation).
-- ---------------------------------------------------------------------------------
CREATE TABLE chat.chat_permissions (
  chat_id    uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  role       text NOT NULL
             CHECK (role IN ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST')),
  permission text NOT NULL
             CHECK (permission IN ('post_messages', 'invite_members', 'create_polls',
                                   'start_calls', 'pin_messages', 'change_info')),
  allowed    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, role, permission)
);

ALTER TABLE chat.chat_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_permissions FORCE ROW LEVEL SECURITY;

-- The row has no workspace_id of its own; it follows the owning chat exactly like
-- chat.channel_settings (V39), which is itself FORCE-RLS-scoped to the workspace GUC.
CREATE POLICY p_chat_permissions_tenant ON chat.chat_permissions
  USING (EXISTS (
      SELECT 1
        FROM chat.chats c
       WHERE c.id = chat_id
         AND c.workspace_id = ops.current_workspace_id()
  ))
  WITH CHECK (EXISTS (
      SELECT 1
        FROM chat.chats c
       WHERE c.id = chat_id
         AND c.workspace_id = ops.current_workspace_id()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON chat.chat_permissions TO krug_app;

COMMENT ON TABLE chat.chat_permissions IS
  'P0-2 effective per-role channel rights (6 permissions); GROUP chats only.';
COMMENT ON COLUMN chat.chat_permissions.allowed IS
  'Effective value: OWNER rows are always true and are rejected by PATCH.';

-- Existing GROUP channels: seed the same defaults the application writes on creation.
INSERT INTO chat.chat_permissions (chat_id, role, permission, allowed)
SELECT c.id, d.role, d.permission, d.allowed
  FROM chat.chats c
 CROSS JOIN (VALUES
        ('OWNER',     'post_messages',  true),
        ('OWNER',     'invite_members', true),
        ('OWNER',     'create_polls',   true),
        ('OWNER',     'start_calls',    true),
        ('OWNER',     'pin_messages',   true),
        ('OWNER',     'change_info',    true),
        ('ADMIN',     'post_messages',  true),
        ('ADMIN',     'invite_members', true),
        ('ADMIN',     'create_polls',   true),
        ('ADMIN',     'start_calls',    true),
        ('ADMIN',     'pin_messages',   true),
        ('ADMIN',     'change_info',    true),
        ('MODERATOR', 'post_messages',  true),
        ('MODERATOR', 'invite_members', true),
        ('MODERATOR', 'create_polls',   true),
        ('MODERATOR', 'start_calls',    true),
        ('MODERATOR', 'pin_messages',   true),
        ('MODERATOR', 'change_info',    false),
        ('MEMBER',    'post_messages',  true),
        ('MEMBER',    'invite_members', false),
        ('MEMBER',    'create_polls',   true),
        ('MEMBER',    'start_calls',    true),
        ('MEMBER',    'pin_messages',   false),
        ('MEMBER',    'change_info',    false),
        ('GUEST',     'post_messages',  true),
        ('GUEST',     'invite_members', false),
        ('GUEST',     'create_polls',   false),
        ('GUEST',     'start_calls',    false),
        ('GUEST',     'pin_messages',   false),
        ('GUEST',     'change_info',    false)
     ) AS d(role, permission, allowed)
 WHERE c.type = 'GROUP'
ON CONFLICT (chat_id, role, permission) DO NOTHING;

-- ---------------------------------------------------------------------------------
-- Per-user archive (user-local, never shared).
-- ---------------------------------------------------------------------------------
CREATE TABLE chat.user_chat_archive (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id)
);

CREATE INDEX ix_user_chat_archive_ws ON chat.user_chat_archive (workspace_id, user_id);

ALTER TABLE chat.user_chat_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.user_chat_archive FORCE ROW LEVEL SECURITY;
-- A user sees and writes only their own archive in the active workspace. No cross-user
-- read path exists: another member's archive is invisible even inside the same tenant.
CREATE POLICY p_user_chat_archive_self ON chat.user_chat_archive
  USING (user_id = ops.current_user_id()
         AND workspace_id = ops.current_workspace_id())
  WITH CHECK (user_id = ops.current_user_id()
              AND workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, DELETE ON chat.user_chat_archive TO krug_app;

COMMENT ON TABLE chat.user_chat_archive IS
  'P0-2 per-user channel archive; self-scoped, no shared or admin read path.';

-- ---------------------------------------------------------------------------------
-- Pins (metadata only; the message body stays in message.messages).
-- ---------------------------------------------------------------------------------
CREATE TABLE chat.chat_pins (
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  message_id   uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  pinned_by    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pinned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX ix_chat_pins_chat_pinned ON chat.chat_pins (chat_id, pinned_at DESC);

ALTER TABLE chat.chat_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY p_chat_pins_tenant ON chat.chat_pins
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, DELETE ON chat.chat_pins TO krug_app;

COMMENT ON TABLE chat.chat_pins IS
  'P0-2 channel pins: (chat_id, message_id) PK, metadata only, tenant RLS.';

-- ---------------------------------------------------------------------------------
-- Existing GROUP channels: keep visibility and join policy coherent.
-- ---------------------------------------------------------------------------------
UPDATE chat.chats c
   SET join_policy = CASE WHEN cs.visibility = 'PUBLIC' THEN 'OPEN' ELSE 'INVITE_ONLY' END
  FROM chat.channel_settings cs
 WHERE cs.chat_id = c.id
   AND c.type = 'GROUP';

-- ---------------------------------------------------------------------------------
-- Accept an invite: same V40 behaviour plus the CLOSED join policy.
--
-- Outcome strings are unchanged except for the new JOIN_CLOSED, which the application maps
-- to 403 CHAT_JOIN_CLOSED. An existing ACTIVE member still receives the idempotent OK
-- before the join policy is consulted, so a closed channel does not break its members.
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
  v_chat_join_policy text;
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

  SELECT c.type, c.deleted_at, c.join_policy
    INTO v_chat_type, v_chat_deleted_at, v_chat_join_policy
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

  -- A CLOSED channel accepts new participants only through an OWNER/ADMIN add.
  IF v_chat_join_policy = 'CLOSED' THEN
    RETURN QUERY SELECT 'JOIN_CLOSED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.chat_id, v_invite.role, false;
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
  '#79/#80 join a GROUP channel by invite token hash: caller/workspace checks, row lock for max_uses, idempotent for existing ACTIVE members, CLOSED join policy rejects new joins';

-- Forward-only rollback plan:
--   DROP FUNCTION chat.accept_invite(text, uuid);  -- recreate the V40 body
--   DROP POLICY p_chat_pins_tenant ON chat.chat_pins;
--   DROP TABLE chat.chat_pins;
--   DROP POLICY p_user_chat_archive_self ON chat.user_chat_archive;
--   DROP TABLE chat.user_chat_archive;
--   DROP POLICY p_chat_permissions_tenant ON chat.chat_permissions;
--   DROP TABLE chat.chat_permissions;
--   ALTER TABLE chat.chats DROP CONSTRAINT fk_chats_cover_file,
--                          DROP CONSTRAINT ck_chats_join_policy,
--                          DROP COLUMN join_policy,
--                          DROP COLUMN cover_file_id;
-- Covers, permission overrides, archives and pins are lost on rollback; chats, participants,
-- messages, files and V39 visibility are untouched.
