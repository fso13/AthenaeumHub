-- #95: polls and tasks become first-class timeline messages.
--
-- Scope and invariants:
--   * a POLL/TASK row is a normal message row: it gets a per-chat seq, participates in
--     history/replay/tombstones and is created only by the server while handling
--     POST /chats/{chatId}/polls or /tasks (there is no client message-creation API for it);
--   * exactly one reference is allowed and it must match the type:
--       POLL -> poll_id NOT NULL, task_id NULL
--       TASK -> task_id NOT NULL, poll_id NULL
--       every other type -> both NULL;
--   * POLL/TASK carry no body ciphertext (no plaintext in E2EE is ever needed: MANAGED-only
--     plugins cannot be enabled in an E2EE chat, and the DB check is a backstop);
--   * FK + a BEFORE INSERT trigger keep the referenced poll/task in the same workspace/chat.
--     The trigger is needed because message.messages is partitioned and the simple FK on
--     poll_id/task_id cannot include workspace_id/chat_id;
--   * ON DELETE CASCADE matches "no poll/task delete API": if a future maintenance path
--     removes an entity, its timeline row cannot dangle. Message tombstones remain the
--     normal user-facing deletion path and are implemented by the message layer.
--
-- The message table is RANGE-partitioned, so ALTER TABLE on the parent clones the new
-- columns, constraints, indexes and FK triggers to every existing partition. Partitions
-- created later inherit them from the parent.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE message.messages
  ADD COLUMN IF NOT EXISTS poll_id uuid;

ALTER TABLE message.messages
  ADD COLUMN IF NOT EXISTS task_id uuid;

-- ---------------------------------------------------------------------------
-- Type / reference invariants
-- ---------------------------------------------------------------------------

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_type;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_type
  CHECK (type IN ('TEXT', 'STICKER', 'SYSTEM', 'POLL', 'TASK'));

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_poll_exactly_one;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_poll_exactly_one
  CHECK (type <> 'POLL' OR (poll_id IS NOT NULL AND task_id IS NULL));

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_task_exactly_one;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_task_exactly_one
  CHECK (type <> 'TASK' OR (task_id IS NOT NULL AND poll_id IS NULL));

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_plugin_refs_only;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_plugin_refs_only
  CHECK (type IN ('POLL', 'TASK') OR (poll_id IS NULL AND task_id IS NULL));

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_poll_no_body;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_poll_no_body
  CHECK (type <> 'POLL' OR body_ciphertext IS NULL);

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_task_no_body;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_task_no_body
  CHECK (type <> 'TASK' OR body_ciphertext IS NULL);

-- E2EE has no plugin metadata: only a MANAGED row may be POLL/TASK. The application gate
-- already rejects plugins in E2EE chats; this is the direct-SQL backstop.
ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_plugin_managed_only;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_plugin_managed_only
  CHECK (type NOT IN ('POLL', 'TASK') OR crypto_scheme = 'MANAGED');

-- ---------------------------------------------------------------------------
-- Foreign keys (existence) + trigger (same workspace/chat)
-- ---------------------------------------------------------------------------

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS fk_messages_poll;
ALTER TABLE message.messages
  ADD CONSTRAINT fk_messages_poll
  FOREIGN KEY (poll_id) REFERENCES plugin.polls (id) ON DELETE CASCADE;

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS fk_messages_task;
ALTER TABLE message.messages
  ADD CONSTRAINT fk_messages_task
  FOREIGN KEY (task_id) REFERENCES plugin.tasks (id) ON DELETE CASCADE;

-- The partitioned parent cannot reference the composite (workspace_id, chat_id, id)
-- keys, so the cross-tenant/chat invariant is enforced by a trigger. SECURITY DEFINER
-- lets the lookup resolve the reference regardless of RLS, but the explicit workspace_id
-- and chat_id comparison makes a foreign reference a hard error rather than a leak.
CREATE OR REPLACE FUNCTION message.enforce_plugin_message_target()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ref_workspace_id uuid;
  ref_chat_id      uuid;
BEGIN
  IF NEW.poll_id IS NOT NULL THEN
    SELECT p.workspace_id, p.chat_id
      INTO ref_workspace_id, ref_chat_id
      FROM plugin.polls p
     WHERE p.id = NEW.poll_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'POLL_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
    IF ref_workspace_id <> NEW.workspace_id OR ref_chat_id <> NEW.chat_id THEN
      RAISE EXCEPTION 'POLL_OTHER_CHAT' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.task_id IS NOT NULL THEN
    SELECT t.workspace_id, t.chat_id
      INTO ref_workspace_id, ref_chat_id
      FROM plugin.tasks t
     WHERE t.id = NEW.task_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'TASK_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
    IF ref_workspace_id <> NEW.workspace_id OR ref_chat_id <> NEW.chat_id THEN
      RAISE EXCEPTION 'TASK_OTHER_CHAT' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION message.enforce_plugin_message_target() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message.enforce_plugin_message_target() TO krug_app;

DROP TRIGGER IF EXISTS trg_messages_plugin_target ON message.messages;
CREATE TRIGGER trg_messages_plugin_target
  BEFORE INSERT ON message.messages
  FOR EACH ROW
  EXECUTE FUNCTION message.enforce_plugin_message_target();

-- ---------------------------------------------------------------------------
-- Indexes: FK maintenance + "which message carries this poll/task?"
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS ix_messages_poll
  ON message.messages (poll_id)
  WHERE poll_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_messages_task
  ON message.messages (task_id)
  WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN message.messages.poll_id IS
  '#95: referenced poll; non-null iff type = POLL. Same workspace/chat enforced by trigger.';
COMMENT ON COLUMN message.messages.task_id IS
  '#95: referenced task; non-null iff type = TASK. Same workspace/chat enforced by trigger.';
COMMENT ON FUNCTION message.enforce_plugin_message_target() IS
  '#95: DB backstop that binds a POLL/TASK message to an entity of the same workspace/chat.';
COMMENT ON CONSTRAINT ck_messages_type ON message.messages IS
  '#95: TEXT/STICKER/SYSTEM/POLL/TASK; POLL/TASK are server-created timeline projections.';

-- Forward-only rollback plan (destructive: the poll/task projection columns are lost,
-- poll/task entities themselves stay):
--   DROP TRIGGER IF EXISTS trg_messages_plugin_target ON message.messages;
--   DROP FUNCTION IF EXISTS message.enforce_plugin_message_target();
--   DROP INDEX IF EXISTS message.ix_messages_poll;
--   DROP INDEX IF EXISTS message.ix_messages_task;
--   ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS fk_messages_poll;
--   ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS fk_messages_task;
--   ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_type;
--   ALTER TABLE message.messages ADD CONSTRAINT ck_messages_type
--     CHECK (type IN ('TEXT', 'STICKER', 'SYSTEM'));
--   ALTER TABLE message.messages DROP COLUMN IF EXISTS poll_id;
--   ALTER TABLE message.messages DROP COLUMN IF EXISTS task_id;
