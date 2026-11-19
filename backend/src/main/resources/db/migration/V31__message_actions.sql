-- D1 message actions: reactions (issues #61/#62) and per-user / for-all deletion (#63).
--
-- Scope and invariants:
--   * message.messages stays the single timeline. Delete-for-all is a soft delete:
--     deleted_at/deleted_by are set, managed body ciphertext is cleared, the row and its
--     seq are kept (threads, receipts, pagination and replay remain stable). No physical
--     message row is ever deleted here.
--   * Delete-for-me is a one-row marker in message.message_deletions. It only changes
--     what the caller's own reads return; other members are unaffected.
--   * Reactions are unique by (message_id, user_id, emoji); adding twice is idempotent.
--     The emoji set is deliberately not a closed enum (clients evolve faster than a
--     migration): the DB bounds the value and forbids whitespace/control/HTML brackets,
--     while the application additionally validates Unicode/emoji ranges.
--
-- Partitioning note: message.messages is RANGE-partitioned by created_at, so a global FK
-- on (id) is impossible. Both child tables carry workspace_id/chat_id denormalised (the
-- same rule as message_envelopes) and integrity is enforced by the application plus the
-- indexes/RLS below. There is no physical content in either table.

CREATE TABLE message.message_reactions (
  message_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  emoji        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji),
  CONSTRAINT ck_message_reactions_emoji_length
    CHECK (char_length(emoji) BETWEEN 1 AND 32),
  -- Plain text only: no whitespace, no control characters and no HTML brackets. The
  -- client renders the value as text, never as markup.
  CONSTRAINT ck_message_reactions_emoji_chars
    CHECK (emoji !~ '[[:cntrl:][:space:]<>]')
);

-- Page aggregation: WHERE workspace_id = ? AND message_id IN (?, ...).
CREATE INDEX ix_message_reactions_ws_message
  ON message.message_reactions (workspace_id, message_id);

-- Used by delete-for-all cleanup and by the "who reacted" ordering in tests/ops.
CREATE INDEX ix_message_reactions_ws_chat
  ON message.message_reactions (workspace_id, chat_id, message_id);

ALTER TABLE message.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message.message_reactions FORCE ROW LEVEL SECURITY;
CREATE POLICY p_message_reactions_tenant ON message.message_reactions
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, DELETE ON message.message_reactions TO krug_app;

CREATE TABLE message.message_deletions (
  message_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Timeline query: NOT EXISTS (message_id = m.id AND user_id = caller) under RLS.
CREATE INDEX ix_message_deletions_ws_user_message
  ON message.message_deletions (workspace_id, user_id, message_id);

ALTER TABLE message.message_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message.message_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY p_message_deletions_tenant ON message.message_deletions
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, DELETE ON message.message_deletions TO krug_app;

COMMENT ON TABLE message.message_reactions IS
  'Issue #61: per-user emoji reactions on a message; PK (message_id,user_id,emoji).';
COMMENT ON TABLE message.message_deletions IS
  'Issue #63: delete-for-me markers; a row hides the message only for that user.';
COMMENT ON COLUMN message.messages.edited_at IS
  'Issue #62: last successful edit timestamp; version is incremented in the same UPDATE.';

-- Forward-only rollback plan (destructive, reactions/hides are lost):
--   DROP TABLE message.message_deletions;
--   DROP TABLE message.message_reactions;
--   message.messages.edited_at/version stay as they were before V31.
