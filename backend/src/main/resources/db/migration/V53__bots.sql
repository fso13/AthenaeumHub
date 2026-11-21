-- #96: Slack-like bots, MVP backend.
--
-- Scope and invariants:
--   * bot.bots is workspace-scoped and FORCE-RLS protected. Only a SHA-256 hash of the
--     one-time bearer token is stored (`token_hash`); the raw token is returned exactly once
--     by create/rotate and is never persisted, logged or audited.
--   * bot.chat_bots stores the per-chat installation (enabled flag). It carries workspace_id
--     for RLS and a composite FK to the bot, plus a trigger that verifies the chat belongs to
--     the same workspace (the app also checks this before every write).
--   * message.messages gets a first-class BOT sender: sender_type + bot_id. A BOT row has no
--     sender_id/device (no impersonation), is always MANAGED and is always a TEXT message.
--     There is no token or secret on the message row.
--   * No E2EE: a bot cannot be installed in, or send to, an E2EE chat (DB backstop below).
--   * No call/file/media surface for bots; a bot token authenticates only
--     POST /bots/{botId}/messages.
--
-- Forward-only rollback plan (after the application rollback):
--   DROP TRIGGER IF EXISTS trg_messages_bot_sender ON message.messages;
--   DROP FUNCTION IF EXISTS message.enforce_bot_message_sender();
--   DELETE FROM message.messages WHERE sender_type = 'BOT';
--   ALTER TABLE message.messages
--     DROP CONSTRAINT IF EXISTS ck_messages_bot_text,
--     DROP CONSTRAINT IF EXISTS ck_messages_bot_managed,
--     DROP CONSTRAINT IF EXISTS ck_messages_bot_shape,
--     DROP CONSTRAINT IF EXISTS ck_messages_sender_type,
--     DROP COLUMN IF EXISTS bot_id,
--     DROP COLUMN IF EXISTS sender_type;
--   DROP TABLE IF EXISTS bot.chat_bots;
--   DROP TABLE IF EXISTS bot.bots;
--   DROP SCHEMA IF EXISTS bot;
-- Bot rows, installations and bot messages are lost on rollback; user messages/chats/files
-- are untouched.

-- ---------------------------------------------------------------------------
-- 1. Bot schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS bot;
GRANT USAGE ON SCHEMA bot TO krug_app;

CREATE TABLE bot.bots (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- Optional bot icon: an existing attachment of the same workspace (ON DELETE SET NULL, so
  -- removing a file never breaks the bot row). Serving an avatar is out of MVP scope.
  avatar_file_id  uuid REFERENCES file.attachments(id) ON DELETE SET NULL,
  -- Exactly one active token per bot. SHA-256 (32 bytes) of the full one-time token; the
  -- raw value exists only in the create/rotate response.
  token_hash      bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  -- MVP scope set: only chat.write. A future subscription scope would be a new migration.
  scopes          text[] NOT NULL DEFAULT ARRAY['chat.write']::text[]
                  CHECK (cardinality(scopes) >= 1
                         AND scopes <@ ARRAY['chat.write']::text[]),
  -- Audit-like actor reference: no FK, so deleting a user does not erase a live bot.
  created_by      uuid NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  token_rotated_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE INDEX ix_bots_workspace_status
  ON bot.bots (workspace_id, status, created_at DESC);

ALTER TABLE bot.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot.bots FORCE ROW LEVEL SECURITY;
CREATE POLICY p_bots_tenant ON bot.bots
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON bot.bots TO krug_app;

CREATE TABLE bot.chat_bots (
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  installed_by uuid NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, bot_id),
  FOREIGN KEY (workspace_id, bot_id)
    REFERENCES bot.bots (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_chat_bots_workspace_bot
  ON bot.chat_bots (workspace_id, bot_id);

ALTER TABLE bot.chat_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot.chat_bots FORCE ROW LEVEL SECURITY;
CREATE POLICY p_chat_bots_tenant ON bot.chat_bots
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON bot.chat_bots TO krug_app;

-- The composite FK already ties (workspace_id, bot_id) to bot.bots; the chat side has only a
-- plain id FK, so a trigger rejects a bot installation into another tenant's chat. The
-- explicit project_id comparison keeps a foreign chat a hard error, not an RLS leak.
CREATE OR REPLACE FUNCTION bot.enforce_chat_bot_workspace()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  chat_workspace_id uuid;
BEGIN
  SELECT c.workspace_id INTO chat_workspace_id
    FROM chat.chats c
   WHERE c.id = NEW.chat_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHAT_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  IF chat_workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'CHAT_OTHER_WORKSPACE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION bot.enforce_chat_bot_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bot.enforce_chat_bot_workspace() TO krug_app;

DROP TRIGGER IF EXISTS trg_chat_bots_workspace ON bot.chat_bots;
CREATE TRIGGER trg_chat_bots_workspace
  BEFORE INSERT OR UPDATE ON bot.chat_bots
  FOR EACH ROW
  EXECUTE FUNCTION bot.enforce_chat_bot_workspace();

COMMENT ON TABLE bot.bots IS
  '#96 bot registry. Only a SHA-256 token hash is stored; raw tokens are one-time.';
COMMENT ON COLUMN bot.bots.token_hash IS
  'SHA-256 of the full bot bearer token (32 bytes). Never the raw token.';
COMMENT ON COLUMN bot.bots.scopes IS
  'MVP capability set: only chat.write. A bot can never read messages, calls or files.';
COMMENT ON TABLE bot.chat_bots IS
  '#96 per-chat bot installation; enabled=false is a soft uninstall kept for audit.';

-- ---------------------------------------------------------------------------
-- 2. BOT sender on the message timeline
-- ---------------------------------------------------------------------------

ALTER TABLE message.messages
  ADD COLUMN IF NOT EXISTS sender_type text NOT NULL DEFAULT 'USER';

ALTER TABLE message.messages
  ADD COLUMN IF NOT EXISTS bot_id uuid;

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_sender_type;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_sender_type
  CHECK (sender_type IN ('USER', 'BOT'));

-- A BOT row is never a user: no sender_id/device, and a bot_id is mandatory. This is the
-- no-impersonation invariant. A USER row never carries bot_id.
ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_bot_shape;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_bot_shape
  CHECK (
    (sender_type = 'USER' AND bot_id IS NULL)
    OR (sender_type = 'BOT' AND bot_id IS NOT NULL
        AND sender_id IS NULL AND sender_device_id IS NULL)
  );

-- Bots are a managed-only feature; E2EE has no plaintext that the server could post.
ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_bot_managed;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_bot_managed
  CHECK (sender_type <> 'BOT' OR crypto_scheme = 'MANAGED');

-- MVP bot messages are plain TEXT with a body and have no plugin/thread/reply payload.
ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_bot_text;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_bot_text
  CHECK (sender_type <> 'BOT'
         OR (type = 'TEXT' AND body_ciphertext IS NOT NULL
             AND reply_to_id IS NULL AND thread_root_id IS NULL
             AND poll_id IS NULL AND task_id IS NULL AND sticker_id IS NULL));

CREATE INDEX IF NOT EXISTS ix_messages_bot
  ON message.messages (bot_id)
  WHERE bot_id IS NOT NULL;

-- Cross-tenant backstop: the bot reference must exist in the message's workspace. The
-- message table is partitioned, so a plain FK cannot include workspace_id; the trigger is
-- the same pattern as V51's poll/task target check.
CREATE OR REPLACE FUNCTION message.enforce_bot_message_sender()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  bot_workspace_id uuid;
BEGIN
  IF NEW.sender_type = 'BOT' THEN
    SELECT b.workspace_id INTO bot_workspace_id
      FROM bot.bots b
     WHERE b.id = NEW.bot_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'BOT_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
    IF bot_workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'BOT_OTHER_WORKSPACE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION message.enforce_bot_message_sender() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message.enforce_bot_message_sender() TO krug_app;

DROP TRIGGER IF EXISTS trg_messages_bot_sender ON message.messages;
CREATE TRIGGER trg_messages_bot_sender
  BEFORE INSERT ON message.messages
  FOR EACH ROW
  EXECUTE FUNCTION message.enforce_bot_message_sender();

COMMENT ON COLUMN message.messages.sender_type IS
  '#96 USER (default) or BOT. A BOT row has bot_id and no sender_id/device.';
COMMENT ON COLUMN message.messages.bot_id IS
  '#96 author bot for sender_type=BOT; display name is snapshotted in sender_display_name.';
