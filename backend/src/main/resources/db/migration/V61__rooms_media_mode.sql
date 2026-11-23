-- #107 Rooms (backend slice): audio/video media mode.
--
-- A room is either an AUDIO room or a VIDEO room. The mode is metadata only: it tells the
-- existing frontend conference code which media to request (`getUserMedia({video: ...})`)
-- and which call-signal `video` flag to send. The backend still keeps no call state, no SDP,
-- no ICE candidates and no SFU/media session, and presence/call signalling are unchanged.
--
-- Additive only:
--   * one new column with a non-null default, so every existing row reads VIDEO without a
--     data backfill and without a table rewrite on PostgreSQL 11+;
--   * one CHECK constraint restricting the value set to AUDIO|VIDEO (same "text + CHECK"
--     style as room.rooms.status; no PostgreSQL enum type to keep future values additive);
--   * no existing column/constraint/index/function is modified or dropped.
--
-- The column is intentionally NOT part of the backing channel: switching a room between
-- AUDIO and VIDEO never recreates the chat, never touches messages/attachments and never
-- revokes existing presence rows.

ALTER TABLE room.rooms
  ADD COLUMN media_mode text NOT NULL DEFAULT 'VIDEO';

ALTER TABLE room.rooms
  ADD CONSTRAINT ck_rooms_media_mode CHECK (media_mode IN ('AUDIO', 'VIDEO'));

COMMENT ON COLUMN room.rooms.media_mode IS
  '#107 AUDIO|VIDEO room media mode (default VIDEO); metadata only, no call/SFU/media state.';

-- Forward-only rollback plan:
--   ALTER TABLE room.rooms DROP CONSTRAINT ck_rooms_media_mode;
--   ALTER TABLE room.rooms DROP COLUMN media_mode;
-- Dropping the column discards the selected mode only; rooms, backing channels, messages,
-- attachments and presence rows are untouched.
