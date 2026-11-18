-- D1-BE1: flat threads. A reply is a normal message with thread_root_id pointing at a
-- main-feed root in the same chat; nesting is not allowed (depth 1).
--
-- Note on FKs: message.messages is RANGE-partitioned by created_at, so a global unique key
-- on (id) does not exist and a self-referencing FK would have to carry created_at, which
-- the client does not know. V4 already documents that integrity is enforced by the
-- application + database backstops. Here the backstops are:
--   * CHECK thread_root_id <> id (no self-reference);
--   * CHECK E2EE rows never carry a thread root;
--   * BEFORE INSERT trigger validating same workspace/chat, root-not-a-reply, live root;
--   * composite (chat_id, thread_root_id, seq) index for thread pages and summaries.
-- The application performs the same checks first and returns typed 422 errors; the trigger
-- is the last line of defence against direct SQL.

ALTER TABLE message.messages
  ADD COLUMN IF NOT EXISTS thread_root_id uuid;

ALTER TABLE message.messages
  DROP CONSTRAINT IF EXISTS ck_messages_thread_no_self;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_thread_no_self
  CHECK (thread_root_id IS NULL OR thread_root_id <> id);

ALTER TABLE message.messages
  DROP CONSTRAINT IF EXISTS ck_messages_e2ee_no_thread_root;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_e2ee_no_thread_root
  CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR thread_root_id IS NULL);

-- Thread page: WHERE chat_id = ? AND thread_root_id = ? AND seq ...; also covers
-- thread_root_id IS NULL (main feed) thanks to the second column.
-- Creating it on the partitioned parent builds it on every existing partition; new
-- partitions created with CREATE TABLE ... PARTITION OF inherit it automatically.
CREATE INDEX IF NOT EXISTS ix_messages_chat_thread_seq
  ON message.messages (chat_id, thread_root_id, seq);

-- Composite integrity backstop. The function is SECURITY DEFINER so it can resolve the
-- root regardless of the caller's RLS visibility, but it still matches workspace_id
-- explicitly: a root from another tenant is THREAD_ROOT_NOT_FOUND, never a cross-tenant
-- reference. The application checks the same conditions to return a typed 422.
CREATE OR REPLACE FUNCTION message.enforce_thread_root()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  root_chat_id        uuid;
  root_thread_root_id uuid;
  root_deleted_at     timestamptz;
  root_crypto_scheme  text;
BEGIN
  IF NEW.thread_root_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.chat_id, m.thread_root_id, m.deleted_at, m.crypto_scheme
    INTO root_chat_id, root_thread_root_id, root_deleted_at, root_crypto_scheme
    FROM message.messages m
   WHERE m.id = NEW.thread_root_id
     AND m.workspace_id = NEW.workspace_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'THREAD_ROOT_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  IF root_chat_id <> NEW.chat_id THEN
    RAISE EXCEPTION 'THREAD_ROOT_OTHER_CHAT' USING ERRCODE = '23514';
  END IF;
  IF root_thread_root_id IS NOT NULL THEN
    RAISE EXCEPTION 'THREAD_NESTING_UNSUPPORTED' USING ERRCODE = '23514';
  END IF;
  IF root_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'THREAD_ROOT_DELETED' USING ERRCODE = '23514';
  END IF;
  IF root_crypto_scheme = 'E2EE_PAIRWISE' THEN
    RAISE EXCEPTION 'THREADS_E2EE_UNSUPPORTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION message.enforce_thread_root() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message.enforce_thread_root() TO krug_app;

DROP TRIGGER IF EXISTS trg_messages_thread_root ON message.messages;
CREATE TRIGGER trg_messages_thread_root
  BEFORE INSERT ON message.messages
  FOR EACH ROW
  EXECUTE FUNCTION message.enforce_thread_root();

COMMENT ON COLUMN message.messages.thread_root_id IS
  'D1-BE1: root of a flat thread (depth 1); NULL for a main-feed message. Managed-only.';
COMMENT ON FUNCTION message.enforce_thread_root() IS
  'D1-BE1: DB backstop for thread_root_id (same chat, root not a reply, live, managed).';
