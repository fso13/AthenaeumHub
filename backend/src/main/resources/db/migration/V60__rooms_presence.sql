-- #105 Rooms (backend slice): workspace video rooms + ephemeral presence.
--
-- A room is a lightweight wrapper around an ordinary managed GROUP channel:
--   * room.rooms stores the room metadata and points at the backing channel via chat_id;
--   * the backing channel is created through the chat context (creator OWNER, every ACTIVE
--     workspace member, PUBLIC/OPEN, MANAGED), so the existing call signalling, history,
--     permissions and attachment flows work unchanged;
--   * room.presence is the only server-side live state: one row per (room, user) with a
--     30-second TTL refreshed by the REST heartbeat. The server keeps no call state, no SDP,
--     no ICE candidates and no SFU/media session; call signalling stays ephemeral on the WS.
--
-- Version note: V59 is reserved for the parallel music-room removal slice, hence V60.
--
-- Additive only: no existing table/column/function is modified. A closed room is retained
-- (status = 'CLOSED'); the backing channel is soft-deleted by the application, so message
-- history and blobs are deliberately not hard-deleted here.

CREATE SCHEMA IF NOT EXISTS room;
GRANT USAGE ON SCHEMA room TO krug_app;

CREATE TABLE room.rooms (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- Audit-like actor reference: no FK, so deleting a user cannot erase the room.
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'CLOSED')),
  -- One channel can back at most one room; prevents accidentally attaching the same
  -- managed channel to two rooms.
  CONSTRAINT uq_rooms_chat UNIQUE (chat_id)
);

-- Main list query: active rooms of one workspace, newest first.
CREATE INDEX ix_rooms_workspace_status_created
  ON room.rooms (workspace_id, status, created_at DESC, id DESC);

CREATE TABLE room.presence (
  room_id      uuid NOT NULL REFERENCES room.rooms(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- TTL read path: participants still present in one room (`last_seen_at > cutoff`).
CREATE INDEX ix_room_presence_room_seen
  ON room.presence (room_id, last_seen_at DESC);
-- TTL cleanup path: find/delete stale rows across all rooms.
CREATE INDEX ix_room_presence_seen
  ON room.presence (last_seen_at);

ALTER TABLE room.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room.rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY p_rooms_tenant ON room.rooms
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

-- Keycloak access tokens have no workspace claim. The room-scoped endpoints resolve the
-- workspace through room.room_scope(), but this additive read policy keeps a plain SELECT
-- safe for an ACTIVE member before the workspace GUC is known (same pattern as V6 chats).
CREATE POLICY p_rooms_member_read ON room.rooms
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM workspace.memberships m
       WHERE m.workspace_id = room.rooms.workspace_id
         AND m.user_id = ops.current_user_id()
         AND m.status = 'ACTIVE'
    )
  );

ALTER TABLE room.presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE room.presence FORCE ROW LEVEL SECURITY;
-- presence has no workspace_id (the contract fixes PK(room_id,user_id)); tenancy is derived
-- from the owning room. room.rooms itself is FORCE-RLS, so this cannot cross tenants.
CREATE POLICY p_presence_tenant ON room.presence
  USING (
    EXISTS (
      SELECT 1
        FROM room.rooms r
       WHERE r.id = room.presence.room_id
         AND r.workspace_id = ops.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM room.rooms r
       WHERE r.id = room.presence.room_id
         AND r.workspace_id = ops.current_workspace_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON room.rooms, room.presence TO krug_app;

-- ---------------------------------------------------------------------------------
-- Resolve the workspace/role of a room before the workspace GUC is known.
-- A plain runtime SELECT cannot traverse FORCE-RLS room.rooms/workspace.memberships
-- without app.workspace_id, hence the narrow SECURITY DEFINER lookup. The actor is bound
-- to the same GUC that RLS uses, so a caller-supplied principal cannot spoof p_user_id.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION room.room_scope(p_room_id uuid, p_user_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_role text,
    room_status text,
    created_by uuid,
    chat_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.workspace_id, m.role::text, r.status::text, r.created_by, r.chat_id
    FROM room.rooms r
    JOIN workspace.memberships m
      ON m.workspace_id = r.workspace_id
     AND m.user_id = p_user_id
     AND m.status = 'ACTIVE'
    JOIN workspace.workspaces w
      ON w.id = r.workspace_id
     AND w.status = 'ACTIVE'
   WHERE r.id = p_room_id
     AND p_user_id = ops.current_user_id()
$$;

REVOKE ALL ON FUNCTION room.room_scope(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION room.room_scope(uuid, uuid) TO krug_app;

-- ---------------------------------------------------------------------------------
-- Presence directory: who is currently in the ACTIVE rooms of one workspace.
-- Returns display_name without exposing email/device/key data, and only for an ACTIVE
-- workspace member (the viewer) of an ACTIVE workspace. The 30 s TTL is passed by the
-- application clock (`p_cutoff = now - 30 s`), so tests can control time explicitly.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION room.presence_directory(
    p_workspace_id uuid,
    p_viewer_id uuid,
    p_cutoff timestamptz)
  RETURNS TABLE (
    room_id uuid,
    user_id uuid,
    display_name text,
    joined_at timestamptz,
    last_seen_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.room_id, p.user_id, u.display_name, p.joined_at, p.last_seen_at
    FROM room.presence p
    JOIN room.rooms r
      ON r.id = p.room_id
     AND r.workspace_id = p_workspace_id
     AND r.status = 'ACTIVE'
    JOIN auth.users u
      ON u.id = p.user_id
    JOIN workspace.memberships wm
      ON wm.workspace_id = p_workspace_id
     AND wm.user_id = p.user_id
     AND wm.status = 'ACTIVE'
    JOIN workspace.workspaces w
      ON w.id = p_workspace_id
     AND w.status = 'ACTIVE'
   WHERE p.last_seen_at > p_cutoff
     AND p_viewer_id = ops.current_user_id()
     AND EXISTS (
         SELECT 1
           FROM workspace.memberships vm
          WHERE vm.workspace_id = p_workspace_id
            AND vm.user_id = p_viewer_id
            AND vm.status = 'ACTIVE'
     )
   ORDER BY p.room_id, p.last_seen_at DESC, p.user_id
$$;

REVOKE ALL ON FUNCTION room.presence_directory(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION room.presence_directory(uuid, uuid, timestamptz) TO krug_app;

-- ---------------------------------------------------------------------------------
-- Physical TTL cleanup. Presence rows are already ignored by every read after 30 s, but
-- this bounded DELETE keeps the table small. It is cross-tenant by design and therefore
-- SECURITY DEFINER; the runtime role cannot delete another tenant's rows directly.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION room.presence_cleanup(p_cutoff timestamptz)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM room.presence WHERE last_seen_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

REVOKE ALL ON FUNCTION room.presence_cleanup(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION room.presence_cleanup(timestamptz) TO krug_app;

COMMENT ON SCHEMA room IS
  '#105 workspace video rooms: metadata + 30-second presence TTL; no call state.';
COMMENT ON TABLE room.rooms IS
  '#105 a room wraps one managed GROUP channel (chat_id) used for call signalling and history.';
COMMENT ON COLUMN room.rooms.chat_id IS
  'Backing GROUP channel; UNIQUE so one channel cannot back two rooms.';
COMMENT ON COLUMN room.rooms.created_by IS
  'Actor that created the room; no FK so user deletion cannot erase the room.';
COMMENT ON COLUMN room.rooms.status IS
  'ACTIVE while join/heartbeat is allowed; CLOSED after soft-close (backing chat soft-deleted).';
COMMENT ON TABLE room.presence IS
  '#105 ephemeral room presence: PK(room_id,user_id), refreshed by REST heartbeat, TTL 30 s.';
COMMENT ON COLUMN room.presence.last_seen_at IS
  'TTL column: presence is live only while last_seen_at > now() - interval ''30 seconds''.';
COMMENT ON FUNCTION room.room_scope(uuid, uuid) IS
  '#105 resolves workspace/role/status of a room for an ACTIVE member before the workspace GUC is known.';
COMMENT ON FUNCTION room.presence_directory(uuid, uuid, timestamptz) IS
  '#105 live (TTL-filtered) room participants with display_name for an ACTIVE workspace member; no email/device/key data.';
COMMENT ON FUNCTION room.presence_cleanup(timestamptz) IS
  '#105 bounded cross-tenant delete of stale room.presence rows (logical TTL is 30 s).';

-- Forward-only rollback plan:
--   DROP FUNCTION room.presence_cleanup(timestamptz);
--   DROP FUNCTION room.presence_directory(uuid, uuid, timestamptz);
--   DROP FUNCTION room.room_scope(uuid, uuid);
--   DROP TABLE room.presence;
--   DROP TABLE room.rooms;
--   DROP SCHEMA room;
-- Room metadata and presence are lost on rollback. The backing chats/messages/attachments
-- are untouched (they were never owned by this schema).
