-- #98: Slack-like bots phase 2 — signed event subscriptions and slash commands.
--
-- Scope and invariants:
--   * A bot may register an https events_url, an explicit subset of event subscriptions
--     (message.created, app_mention) and a per-bot delivery switch. The signing secret is
--     generated/rotated server-side and stored ONLY encrypted (AES-256-GCM); the raw value
--     is revealed exactly once by the API and never persisted/logged in clear.
--   * Event deliveries are a durable outbox (bot.event_deliveries). A row is appended in the
--     same transaction as the message/command that produced it, and the relay/fan-out only
--     runs after that commit. UNIQUE (bot_id, event_type, event_id) makes an idempotent
--     replay a no-op instead of a duplicate webhook.
--   * Slash commands are registered per bot (`commands` jsonb) and invoked by an active chat
--     member. Invocation creates a one-time response token (only its SHA-256 hash is stored)
--     and a signed `slash_command` delivery; it does NOT create a chat message.
--   * All tables are FORCE-RLS tenant scoped. The delivery worker uses the narrow
--     `bot-event-relay` worker role (app.worker_role), never a tenant GUC.
--   * No E2EE: a bot/command/response is MANAGED-only. No file, call or read scope is added.
--
-- Forward-only rollback plan (after the application rollback):
--   DROP POLICY IF EXISTS p_bot_event_deliveries_worker ON bot.event_deliveries;
--   DROP TABLE IF EXISTS bot.event_deliveries;
--   DROP TABLE IF EXISTS bot.command_tokens;
--   DROP POLICY IF EXISTS p_bots_worker ON bot.bots;
--   ALTER TABLE bot.bots
--     DROP CONSTRAINT IF EXISTS ck_bots_events_url,
--     DROP CONSTRAINT IF EXISTS ck_bots_event_types,
--     DROP CONSTRAINT IF EXISTS ck_bots_commands,
--     DROP CONSTRAINT IF EXISTS ck_bots_signing_secret,
--     DROP COLUMN IF EXISTS commands,
--     DROP COLUMN IF EXISTS signing_secret_created_at,
--     DROP COLUMN IF EXISTS signing_secret_encrypted,
--     DROP COLUMN IF EXISTS events_enabled,
--     DROP COLUMN IF EXISTS event_types,
--     DROP COLUMN IF EXISTS events_url;
-- Deliveries, response tokens and event configuration are lost; messages/chats/users are
-- untouched.

-- ---------------------------------------------------------------------------
-- 1. Bot event configuration
-- ---------------------------------------------------------------------------

ALTER TABLE bot.bots
  ADD COLUMN IF NOT EXISTS events_url text;

ALTER TABLE bot.bots
  ADD COLUMN IF NOT EXISTS event_types text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE bot.bots
  ADD COLUMN IF NOT EXISTS events_enabled boolean NOT NULL DEFAULT false;

-- AES-256-GCM blob [version][12-byte nonce][ciphertext+tag]. The raw signing secret never
-- exists in a column, audit row or log line.
ALTER TABLE bot.bots
  ADD COLUMN IF NOT EXISTS signing_secret_encrypted bytea;

ALTER TABLE bot.bots
  ADD COLUMN IF NOT EXISTS signing_secret_created_at timestamptz;

ALTER TABLE bot.bots
  ADD COLUMN IF NOT EXISTS commands jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE bot.bots DROP CONSTRAINT IF EXISTS ck_bots_events_url;
ALTER TABLE bot.bots
  ADD CONSTRAINT ck_bots_events_url
  CHECK (events_url IS NULL
         OR (length(events_url) BETWEEN 9 AND 2048
             AND events_url ~ '^https://[^/?#@[:space:]]+([/][^?#@[:space:]]*)?$'));

ALTER TABLE bot.bots DROP CONSTRAINT IF EXISTS ck_bots_event_types;
ALTER TABLE bot.bots
  ADD CONSTRAINT ck_bots_event_types
  CHECK (event_types <@ ARRAY['message.created', 'app_mention']::text[]);

ALTER TABLE bot.bots DROP CONSTRAINT IF EXISTS ck_bots_signing_secret;
ALTER TABLE bot.bots
  ADD CONSTRAINT ck_bots_signing_secret
  CHECK (signing_secret_encrypted IS NULL
         OR octet_length(signing_secret_encrypted) BETWEEN 29 AND 4096);

ALTER TABLE bot.bots DROP CONSTRAINT IF EXISTS ck_bots_commands;
ALTER TABLE bot.bots
  ADD CONSTRAINT ck_bots_commands
  CHECK (jsonb_typeof(commands) = 'array');

-- The delivery worker needs to read the bot's URL/secret and mark deliveries. It is a
-- SELECT-only cross-tenant path activated by set_config('app.worker_role', 'bot-event-relay').
DROP POLICY IF EXISTS p_bots_worker ON bot.bots;
CREATE POLICY p_bots_worker ON bot.bots
  FOR SELECT
  USING (current_setting('app.worker_role', true) = 'bot-event-relay');

COMMENT ON COLUMN bot.bots.events_url IS
  '#98 https-only event endpoint. SSRF is checked again on every delivery (resolved IPs).';
COMMENT ON COLUMN bot.bots.event_types IS
  '#98 explicit subscription subset: message.created and/or app_mention.';
COMMENT ON COLUMN bot.bots.signing_secret_encrypted IS
  '#98 AES-256-GCM signing secret; raw value is revealed once and never stored.';
COMMENT ON COLUMN bot.bots.commands IS
  '#98 slash commands [{command, description}] registered by the bot owner.';

-- ---------------------------------------------------------------------------
-- 2. Durable event delivery outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bot.event_deliveries (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  bot_id              uuid NOT NULL,
  chat_id             uuid,
  event_type          text NOT NULL
                      CHECK (event_type IN ('message.created', 'app_mention',
                                            'slash_command', 'test')),
  -- Stable producer id: message id for message events, command-token id for slash commands,
  -- random id for test pings. Together with (bot_id, event_type) it de-duplicates replays.
  event_id            uuid NOT NULL,
  -- AES-GCM envelope JSON, encrypted with the content key and bound to the delivery id.
  payload_encrypted   bytea,
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_status_code    integer,
  -- Content-free reason only ("timeout", "http_500", "private_address", ...).
  last_error          text CHECK (last_error IS NULL OR length(last_error) <= 120),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  FOREIGN KEY (workspace_id, bot_id)
    REFERENCES bot.bots (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (bot_id, event_type, event_id)
);

CREATE INDEX IF NOT EXISTS ix_bot_event_deliveries_due
  ON bot.event_deliveries (status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS ix_bot_event_deliveries_bot_created
  ON bot.event_deliveries (workspace_id, bot_id, created_at DESC, id);

ALTER TABLE bot.event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot.event_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_bot_event_deliveries_tenant ON bot.event_deliveries;
CREATE POLICY p_bot_event_deliveries_tenant ON bot.event_deliveries
  FOR ALL
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS p_bot_event_deliveries_worker ON bot.event_deliveries;
CREATE POLICY p_bot_event_deliveries_worker ON bot.event_deliveries
  FOR ALL
  USING (current_setting('app.worker_role', true) = 'bot-event-relay')
  WITH CHECK (current_setting('app.worker_role', true) = 'bot-event-relay');

GRANT SELECT, INSERT, UPDATE, DELETE ON bot.event_deliveries TO krug_app;

COMMENT ON TABLE bot.event_deliveries IS
  '#98 durable bot webhook outbox. Payload is encrypted; last_error is content-free.';

-- ---------------------------------------------------------------------------
-- 3. One-time slash-command response tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bot.command_tokens (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id         uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  bot_id          uuid NOT NULL,
  invoked_by      uuid NOT NULL,
  command         text NOT NULL CHECK (length(command) BETWEEN 1 AND 32),
  -- Only SHA-256 (32 bytes) of the capability token that the bot receives in response_url.
  token_hash      bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  response_message_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, bot_id)
    REFERENCES bot.bots (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_command_tokens_hash
  ON bot.command_tokens (token_hash);

CREATE INDEX IF NOT EXISTS ix_bot_command_tokens_expiry
  ON bot.command_tokens (expires_at);

ALTER TABLE bot.command_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot.command_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_bot_command_tokens_tenant ON bot.command_tokens;
CREATE POLICY p_bot_command_tokens_tenant ON bot.command_tokens
  FOR ALL
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON bot.command_tokens TO krug_app;

COMMENT ON TABLE bot.command_tokens IS
  '#98 one-time response_url capability. Only a SHA-256 hash is stored; TTL 5 minutes.';
