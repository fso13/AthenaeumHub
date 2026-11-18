-- D1-BE3: editable chat settings (name/description) and workspace-level scope lookup.
--
-- * chat.chats.description — plain-text description (never HTML), nullable, <= 500 chars.
-- * name stays nullable (DIRECT has no server-side name), but when present it must be
--   1..120 chars. Application validation is the primary gate; these CHECKs are a DB
--   backstop for any write path (including future admin tooling).
-- * chat.settings_scope(chat_id, user_id) resolves the workspace of a live chat for an
--   ACTIVE workspace member. The PATCH endpoint needs this before it knows workspace_id
--   (the URL has no workspace), and it must not require chat membership: D1-BE3 uses
--   workspace OWNER/ADMIN roles, so a workspace ADMIN who was added after the chat exists
--   may edit it. A plain runtime SELECT cannot traverse FORCE-RLS chat.chats/
--   workspace.memberships without the workspace GUC, hence the narrow SECURITY DEFINER.

ALTER TABLE chat.chats
  ADD COLUMN description text;

ALTER TABLE chat.chats
  ADD CONSTRAINT ck_chats_name_length
    CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT ck_chats_description_length
    CHECK (description IS NULL OR char_length(description) <= 500);

CREATE OR REPLACE FUNCTION chat.settings_scope(p_chat_id uuid, p_user_id uuid)
  RETURNS TABLE (workspace_id uuid, workspace_role text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.workspace_id, m.role::text
    FROM chat.chats c
    JOIN workspace.memberships m
      ON m.workspace_id = c.workspace_id
     AND m.user_id = p_user_id
     AND m.status = 'ACTIVE'
    JOIN workspace.workspaces w
      ON w.id = c.workspace_id
     AND w.status = 'ACTIVE'
   WHERE c.id = p_chat_id
     AND c.deleted_at IS NULL
     -- The app actor cannot be spoofed by a caller-supplied principal: the same GUC
     -- that RLS uses must identify p_user_id.
     AND p_user_id = ops.current_user_id()
$$;

REVOKE ALL ON FUNCTION chat.settings_scope(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat.settings_scope(uuid, uuid) TO krug_app;

COMMENT ON COLUMN chat.chats.description IS
  'D1-BE3 plain-text description; null when unset/cleared; never HTML.';

-- Forward-only rollback plan:
--   DROP FUNCTION chat.settings_scope(uuid, uuid);
--   ALTER TABLE chat.chats DROP CONSTRAINT ck_chats_description_length,
--                          DROP CONSTRAINT ck_chats_name_length,
--                          DROP COLUMN description;
-- Description data is lost on rollback; other chat/message data is untouched.
