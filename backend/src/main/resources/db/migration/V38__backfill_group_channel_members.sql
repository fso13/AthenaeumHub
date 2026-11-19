-- Channels are workspace-wide: existing GROUP chats were created before membership
-- synchronization, so the participant picker (and group calls) saw only the creator.
-- Add every ACTIVE workspace member idempotently; DIRECT chats are untouched.
INSERT INTO chat.chat_members
    (chat_id, workspace_id, user_id, role, status, joined_at, updated_at)
SELECT c.id, c.workspace_id, wm.user_id, 'MEMBER', 'ACTIVE', now(), now()
  FROM chat.chats c
  JOIN workspace.memberships wm
    ON wm.workspace_id = c.workspace_id
   AND wm.status = 'ACTIVE'
 WHERE c.type = 'GROUP'
   AND c.deleted_at IS NULL
ON CONFLICT (chat_id, user_id) DO NOTHING;

-- Forward-only: removing these rows would silently remove channel visibility.
