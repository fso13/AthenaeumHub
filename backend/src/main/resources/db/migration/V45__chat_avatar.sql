-- P0-2 follow-up / #80: channel icons/avatars (V45: V44 is taken by the plugin-package
-- migration developed in parallel).
--
-- Additive only. Nothing from V39 (channel settings) or V41 (cover/rights/archive/pins) is
-- altered and no existing RLS policy or grant is weakened.
--
-- Design notes:
--   * avatar_file_id references an existing CLEAN image attachment of the same chat. There is
--     no new upload pipeline: the client uses the regular file flow and references the
--     resulting attachment id, exactly like the cover (V41) and the profile avatar (V43).
--   * ON DELETE SET NULL guarantees no dangling avatar if the attachment row is removed. The
--     reference is also cleared on chat soft delete by the application.
--   * chat.chats already has ENABLE/FORCE RLS (V3, tenant workspace GUC) and table-level
--     SELECT/INSERT/UPDATE/DELETE grants for krug_app, so a new column needs no new policy or
--     grant: the avatar inherits the chat's tenant isolation.
--   * avatar_file_id is GROUP-only. DIRECT chats keep NULL and the API rejects changing it.

ALTER TABLE chat.chats
  ADD COLUMN avatar_file_id uuid;

ALTER TABLE chat.chats
  ADD CONSTRAINT fk_chats_avatar_file
    FOREIGN KEY (avatar_file_id) REFERENCES file.attachments(id) ON DELETE SET NULL;

COMMENT ON COLUMN chat.chats.avatar_file_id IS
  'Channel avatar: CLEAN image attachment of the same chat; NULL for DIRECT; ON DELETE SET NULL.';

-- Forward-only rollback plan:
--   ALTER TABLE chat.chats DROP CONSTRAINT fk_chats_avatar_file,
--                          DROP COLUMN avatar_file_id;
-- Avatar references are lost on rollback; covers, chats, participants, messages and files are
-- untouched.
