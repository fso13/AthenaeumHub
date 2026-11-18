-- message module: monthly range-partitioned timeline, per-chat seq unique per partition.

CREATE TABLE message.messages (
  id                  uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  chat_id             uuid NOT NULL,
  seq                 bigint NOT NULL CHECK (seq > 0),
  sender_id           uuid,
  sender_device_id    uuid,
  -- Denormalised for the timeline read model; avoids a cross-module join to auth.users.
  sender_display_name text,
  type                text NOT NULL CHECK (type IN ('TEXT', 'SYSTEM')),
  crypto_scheme       text NOT NULL DEFAULT 'MANAGED'
                      CHECK (crypto_scheme IN ('NONE', 'MANAGED', 'E2EE_PAIRWISE', 'E2EE_SENDER_KEY')),
  -- Managed mode: AES-GCM ciphertext produced by the backend. E2EE payloads are out of scope.
  body_ciphertext     bytea,
  content_meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_message_id   uuid,
  reply_to_id         uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  edited_at           timestamptz,
  deleted_at          timestamptz,
  deleted_by          uuid,
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (id, created_at),
  CHECK (type <> 'TEXT' OR body_ciphertext IS NOT NULL),
  CHECK (type <> 'SYSTEM' OR body_ciphertext IS NULL)
) PARTITION BY RANGE (created_at);

-- No FK to chat.chats/auth.users: a partitioned table cannot have a global unique key
-- (see SYSTEM-ANALYSIS §6.3). Integrity is enforced by the application + orphan check.

-- Idempotent partition provisioning (called by the migration and by the ops scheduler).
CREATE OR REPLACE FUNCTION message.ensure_partition(p_month date)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (start_date + interval '1 month')::date;
  part_name  text := format('messages_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS message.%I PARTITION OF message.messages FOR VALUES FROM (%L) TO (%L)',
    part_name, start_date, end_date);
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I (chat_id, seq)',
    'ux_' || part_name || '_chat_seq', part_name);
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I (chat_id, client_message_id) WHERE client_message_id IS NOT NULL',
    'ux_' || part_name || '_client', part_name);
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON message.%I (chat_id, created_at DESC)',
    'ix_' || part_name || '_chat_created', part_name);
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON message.%I (workspace_id, chat_id, seq)',
    'ix_' || part_name || '_ws_chat_seq', part_name);
  EXECUTE format('ALTER TABLE message.%I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE message.%I FORCE ROW LEVEL SECURITY', part_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON message.%I',
                 'p_' || part_name || '_tenant', part_name);
  EXECUTE format(
    'CREATE POLICY %I ON message.%I USING (workspace_id = ops.current_workspace_id()) WITH CHECK (workspace_id = ops.current_workspace_id())',
    'p_' || part_name || '_tenant', part_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON message.%I TO krug_app', part_name);
END
$$;

ALTER TABLE message.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY p_messages_tenant ON message.messages
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON message.messages TO krug_app;
GRANT EXECUTE ON FUNCTION message.ensure_partition(date) TO krug_app;

-- Current month + two future months (minimum required by B-01 is current + next).
SELECT message.ensure_partition(date_trunc('month', now())::date);
SELECT message.ensure_partition((date_trunc('month', now()) + interval '1 month')::date);
SELECT message.ensure_partition((date_trunc('month', now()) + interval '2 months')::date);
