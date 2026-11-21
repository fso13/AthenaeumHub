-- #94 Music Room (backend slice 1.0.0):
--   * a sixth built-in plugin `music-room` (MANAGED, permissions FILES/MESSAGES);
--   * a per-workspace channel tag so the room is idempotent and cannot be duplicated.
--
-- Scope: no audio/SFU server, no media proxy and no playback state on the server. The
-- channel is an ordinary managed GROUP channel; the frontend lists its AUDIO attachments
-- and mixes them locally into the call. The plugin catalog row is metadata only, exactly
-- like the other built-ins (no plugin code is executed).
--
-- Version note: built-in catalog rows intentionally carry no package version
-- (V44 ck_plugin_catalog_external_metadata: kind='BUILTIN' => version IS NULL). The
-- music-room plugin version 1.0.0 is exposed by the API (`MusicRoomPlugin.version`) and
-- documented in backend/MUSIC-ROOM-REPORT.md; it is not stored as package metadata.
--
-- Additive only: V34/V39/V41 catalog, chat and channel_settings stay untouched.

INSERT INTO plugin.catalog
  (id, name, description, icon, permissions, modes, state, sort_order)
VALUES
  ('music-room', 'Музыкальная комната',
   'Совместное прослушивание музыки: аудиофайлы канала и общий плеер.',
   'music', ARRAY['FILES', 'MESSAGES']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 60)
ON CONFLICT (id) DO NOTHING;

-- One plugin-owned channel per workspace. PK(workspace_id, plugin_id) is the database
-- backstop for "no duplicate music room per workspace"; the application additionally
-- serialises the find-or-create transaction with an advisory lock. `chat_id` is unique so a
-- chat can belong to at most one plugin room. Soft-deleting the chat leaves the tag row in
-- place; the next open replaces the stale reference with a fresh live channel.
CREATE TABLE chat.plugin_rooms (
  workspace_id uuid NOT NULL,
  plugin_id    text NOT NULL REFERENCES plugin.catalog(id) ON DELETE RESTRICT,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  -- Audit-like actor reference: no FK, so deleting a user cannot erase the room tag.
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, plugin_id),
  CONSTRAINT uq_plugin_rooms_chat UNIQUE (chat_id)
);

ALTER TABLE chat.plugin_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.plugin_rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_rooms_tenant ON chat.plugin_rooms
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON chat.plugin_rooms TO krug_app;

COMMENT ON TABLE chat.plugin_rooms IS
  '#94 one plugin-owned channel per workspace (music-room); no duplicate room.';
COMMENT ON COLUMN chat.plugin_rooms.created_by IS
  'Actor that opened the room; no FK so user deletion cannot erase the tag.';
COMMENT ON COLUMN chat.plugin_rooms.chat_id IS
  'Live or soft-deleted GROUP channel; UNIQUE prevents one chat owning two plugin rooms.';

-- Forward-only rollback plan:
--   DROP TABLE chat.plugin_rooms;
--   DELETE FROM plugin.catalog WHERE id = 'music-room';
-- The room tag and the catalog row are lost on rollback; existing chats, members, messages
-- and files (including AUDIO attachments) are untouched.
