-- #94 Music Room removal.
--
-- V52 introduced the built-in `music-room` plugin, its per-chat toggles and the
-- `chat.plugin_rooms` workspace tag. The plugin is removed from the product, so this
-- forward-only migration cleans up its database footprint. V52 itself is left intact:
-- it has already been applied on existing installations and Flyway checksums forbid
-- editing it. Fresh databases run V52 (seed) and then V59 (cleanup), converging to the
-- same five built-in plugins as upgraded databases.
--
-- What stays untouched:
--   * every chat row, including GROUP channels that were created as music rooms. They
--     remain ordinary managed GROUP channels with their messages, members and files;
--   * every AUDIO attachment and its metadata (the file center is independent of the
--     plugin);
--   * plugin.catalog rows for the other built-ins and any external package.
--
-- Order matters: `chat.plugin_rooms.plugin_id` and `chat.chat_plugins.plugin_id` both
-- reference `plugin.catalog(id)` with ON DELETE RESTRICT, so the dependent rows/table
-- must go before the catalog row.

-- The tag table is owned by this plugin only. Dropping it also drops its RLS policy and
-- the `krug_app` SELECT/INSERT/UPDATE/DELETE grants; no other table references it.
DROP TABLE IF EXISTS chat.plugin_rooms;

-- Per-chat enablement rows are plugin state, not user content. Remove only this plugin's
-- rows so a later catalog id reuse (if ever) starts clean. The table is FORCE RLS (V34), so
-- temporarily let the table owner bypass the tenant policy; the exact FORCE posture is
-- restored immediately. This keeps the cleanup effective on managed databases where the
-- migrator is the table owner but not a superuser.
ALTER TABLE chat.chat_plugins NO FORCE ROW LEVEL SECURITY;
DELETE FROM chat.chat_plugins WHERE plugin_id = 'music-room';
ALTER TABLE chat.chat_plugins FORCE ROW LEVEL SECURITY;

-- Built-in catalog row. `channel_id`/chat references never point at the catalog, so the
-- channel created by the old endpoint is preserved as a normal GROUP chat.
DELETE FROM plugin.catalog WHERE id = 'music-room';

-- Forward-only rollback plan (restores the V52 shape from version control):
--   re-run V52__music_room_plugin.sql;
--   re-enable the removed plugin in any channel where it was on, if desired.
-- Existing rooms are not re-tagged automatically: they are plain chats after this
-- migration. There is no data loss of chats, members, messages or files.
