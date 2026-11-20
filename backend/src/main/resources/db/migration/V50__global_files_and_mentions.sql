-- #83: global workspace files and server-side mentions.
--
-- Two additive model changes:
--
-- 1. Workspace-scoped ("global") files. `POST /workspaces/{workspaceId}/files` stores a
--    regular managed attachment that belongs to no chat yet. It keeps the existing upload /
--    AV pipeline (source = 'WORKSPACE' still requires an upload session), so nothing about
--    the fail-closed scan path changes. `file.uploads.chat_id` becomes nullable for exactly
--    this flow; a regular `/uploads` session always writes a chat.
--    Binding a workspace file to a message sets `chat_id` and status = 'BOUND' in the same
--    message transaction (see MessageAttachmentService).
--
-- 2. Mentions. `message.mentions` is the per-recipient inbox (read state, keyset pagination
--    for `GET /me/mentions`), while `message.messages.mentions` keeps the explicit mentioned
--    user ids in the message payload so a message read needs no extra query. `mention_all`
--    is materialised into one row per active chat member at send time, so "@all" never
--    expands at read time and a later member cannot see an older @all.
--
-- Security posture is unchanged: every new/changed table keeps ENABLE/FORCE ROW LEVEL
-- SECURITY with the tenant policy (workspace_id = ops.current_workspace_id()); no grant was
-- widened. E2EE chats never produce mention rows (the send path rejects plaintext metadata
-- before this table is touched), and the remote-ciphertext search never reads these columns.
--
-- Forward-only rollback plan (only after the application rollback):
--   DROP TABLE IF EXISTS message.mentions;
--   ALTER TABLE message.messages DROP COLUMN IF EXISTS mentions, DROP COLUMN IF EXISTS mention_all;
--   DELETE FROM file.attachments WHERE source = 'WORKSPACE';
--   ALTER TABLE file.attachments DROP CONSTRAINT ck_attachments_source_shape;
--   ALTER TABLE file.attachments DROP CONSTRAINT ck_attachments_source;
--   ALTER TABLE file.attachments ADD CONSTRAINT ck_attachments_source CHECK (source IN ('UPLOAD','DIRECT_IMAGE'));
--   ALTER TABLE file.attachments ADD CONSTRAINT ck_attachments_source_shape CHECK (...);
--   ALTER TABLE file.uploads ALTER COLUMN chat_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. Global (workspace-scoped) files
-- ---------------------------------------------------------------------------

ALTER TABLE file.uploads ALTER COLUMN chat_id DROP NOT NULL;

ALTER TABLE file.attachments DROP CONSTRAINT ck_attachments_source_shape;
ALTER TABLE file.attachments DROP CONSTRAINT ck_attachments_source;

ALTER TABLE file.attachments
  ADD CONSTRAINT ck_attachments_source
  CHECK (source IN ('UPLOAD', 'DIRECT_IMAGE', 'WORKSPACE'));

ALTER TABLE file.attachments
  ADD CONSTRAINT ck_attachments_source_shape
  CHECK (
    (source = 'UPLOAD' AND upload_id IS NOT NULL AND chat_id IS NOT NULL)
    OR (
      source = 'DIRECT_IMAGE'
      AND upload_id IS NULL
      AND scan_status = 'SKIPPED'
      AND status IN ('READY', 'BOUND', 'DELETED')
      AND media IS NOT NULL
      AND media->>'kind' = 'IMAGE'
    )
    OR (
      -- A global file always keeps its upload session (quota + AV). Its chat_id is NULL
      -- until it is attached to a message, and is set to that chat by the bind transaction.
      source = 'WORKSPACE'
      AND upload_id IS NOT NULL
      AND status IN ('READY', 'BOUND', 'DELETED')
      AND scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'FAILED')
    )
  );

-- The file-center lists the caller's own global files; the partial index keeps that lookup
-- independent from the chat-provenance indexes.
CREATE INDEX ix_attachments_workspace_owner
  ON file.attachments (workspace_id, user_id, created_at DESC)
  WHERE source = 'WORKSPACE';

COMMENT ON COLUMN file.uploads.chat_id IS
  '#83: NULL only for a workspace-scoped global file (POST /workspaces/{id}/files)';
COMMENT ON COLUMN file.attachments.source IS
  '#92/#83: UPLOAD = regular chat upload; DIRECT_IMAGE = trusted avatar/cover image; '
  'WORKSPACE = global workspace file (upload session + AV, chat_id NULL until bound)';

-- ---------------------------------------------------------------------------
-- 2. Mentions
-- ---------------------------------------------------------------------------

ALTER TABLE message.messages
  ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE message.messages
  ADD COLUMN mention_all boolean NOT NULL DEFAULT false;

ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_mentions_array
  CHECK (jsonb_typeof(mentions) = 'array');

COMMENT ON COLUMN message.messages.mentions IS
  '#83: explicit mentioned user ids (jsonb array of uuid strings); always [] for E2EE';
COMMENT ON COLUMN message.messages.mention_all IS
  '#83: "@all" marker; only OWNER/ADMIN of the chat may set it; always false for E2EE';

CREATE TABLE message.mentions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL,
  message_id   uuid NOT NULL,
  -- The mentioned recipient. "@all" is materialised into one row per active member at send
  -- time, so this column is never null and the inbox query is a plain (user_id, created_at)
  -- keyset scan.
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mention_all  boolean NOT NULL DEFAULT false,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per (message, recipient): a repeated id in the payload cannot double-notify.
CREATE UNIQUE INDEX uq_mentions_message_user
  ON message.mentions (message_id, user_id);

-- Stable inbox order and keyset pagination: (created_at DESC, id DESC).
CREATE INDEX ix_mentions_user_created
  ON message.mentions (user_id, created_at DESC, id DESC);

CREATE INDEX ix_mentions_user_unread
  ON message.mentions (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX ix_mentions_message
  ON message.mentions (message_id);

ALTER TABLE message.mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message.mentions FORCE ROW LEVEL SECURITY;

CREATE POLICY p_mentions_tenant ON message.mentions
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON message.mentions TO krug_app;

COMMENT ON TABLE message.mentions IS
  '#83: per-recipient mention inbox. Written in the message send transaction, tenant-RLS '
  'scoped; read by GET /me/mentions and marked read by POST /me/mentions/read';
