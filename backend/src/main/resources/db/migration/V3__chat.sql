-- chat module: chats, participants, per-chat seq allocator, read receipts.

CREATE TABLE chat.chats (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('DIRECT', 'GROUP')),
  security_mode   text NOT NULL CHECK (security_mode IN ('MANAGED', 'E2EE')),
  name            text,
  created_by      uuid,
  last_message_at timestamptz,
  read_only       boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX ix_chats_ws_last_message
  ON chat.chats (workspace_id, last_message_at DESC NULLS LAST);
CREATE INDEX ix_chats_ws_type ON chat.chats (workspace_id, type);

CREATE TABLE chat.chat_members (
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST')),
  status       text NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('INVITED', 'ACTIVE', 'REMOVED')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX ix_chat_members_user_status ON chat.chat_members (user_id, status);
CREATE INDEX ix_chat_members_ws ON chat.chat_members (workspace_id, user_id);

CREATE TABLE chat.chat_counters (
  chat_id         uuid PRIMARY KEY REFERENCES chat.chats(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL,
  next_seq        bigint NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  last_message_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat.read_receipts (
  chat_id       uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX ix_read_receipts_user ON chat.read_receipts (user_id, updated_at DESC);

ALTER TABLE chat.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.chats FORCE ROW LEVEL SECURITY;
CREATE POLICY p_chats_tenant ON chat.chats
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

ALTER TABLE chat.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_members FORCE ROW LEVEL SECURITY;
CREATE POLICY p_chat_members_tenant ON chat.chat_members
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

ALTER TABLE chat.chat_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY p_chat_counters_tenant ON chat.chat_counters
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

ALTER TABLE chat.read_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.read_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY p_read_receipts_tenant ON chat.read_receipts
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON chat.chats, chat.chat_members, chat.chat_counters, chat.read_receipts
  TO krug_app;
