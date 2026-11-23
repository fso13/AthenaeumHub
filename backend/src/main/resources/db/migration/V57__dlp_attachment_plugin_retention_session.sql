-- #101: DLP coverage for attachments/edits/plugin payloads, workspace retention
-- enforcement and server-side session idle tracking.
--
-- Additive only. No existing row, column, policy or grant is removed or weakened:
--   * workspace.dlp_policies gains a bounded `scope` and an optional attachment size
--     threshold. Existing rules are treated as scope = 'ALL' (the pre-#101 behaviour is a
--     superset: a text rule now also matches an attachment name / plugin payload).
--   * auth.session_activity is a self-scoped (RLS) last-activity marker for a Keycloak
--     session id (`sid` claim). It stores no token, IP, user agent or content.
--   * workspace.retention_runs stores per-workspace counters of the daily retention job.
--   * workspace.retention_targets() and workspace.effective_session_timeout_minutes() are
--     narrow SECURITY DEFINER functions. Both re-check the caller/worker identity in SQL;
--     they are owned by the migration role and granted to krug_app only.
--   * A partitioned message index supports the retention scan; it is inherited by every
--     current and future partition (message.ensure_partition() is updated accordingly).

-- ---------------------------------------------------------------------------------
-- DLP: enforce on attachment metadata and plugin payloads, not only message text.
-- ---------------------------------------------------------------------------------
ALTER TABLE workspace.dlp_policies
  ADD COLUMN scope text NOT NULL DEFAULT 'ALL'
    CHECK (scope IN ('ALL', 'TEXT', 'ATTACHMENT', 'PLUGIN'));

ALTER TABLE workspace.dlp_policies
  ADD COLUMN max_file_size_bytes bigint
    CHECK (max_file_size_bytes IS NULL
           OR max_file_size_bytes BETWEEN 1 AND 10737418240);

COMMENT ON COLUMN workspace.dlp_policies.scope IS
  '#101 surface: ALL (default), TEXT (message/edit/plugin text), ATTACHMENT or PLUGIN.';
COMMENT ON COLUMN workspace.dlp_policies.max_file_size_bytes IS
  '#101 attachment-only size threshold; NULL = the pattern alone decides. No content is stored.';

-- ---------------------------------------------------------------------------------
-- Server-side session idle tracking (Keycloak `sid`). Content-free by construction.
-- ---------------------------------------------------------------------------------
CREATE TABLE auth.session_activity (
  session_id       text PRIMARY KEY
                   CHECK (char_length(session_id) BETWEEN 1 AND 128),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_session_activity_user_activity
  ON auth.session_activity (user_id, last_activity_at DESC);
CREATE INDEX ix_session_activity_last_seen
  ON auth.session_activity (last_activity_at);

ALTER TABLE auth.session_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.session_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY p_session_activity_self ON auth.session_activity
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session_activity TO krug_app;

COMMENT ON TABLE auth.session_activity IS
  '#101 last-activity marker per Keycloak session id; no token, IP or content is stored.';

-- Effective idle timeout: the strictest ACTIVE workspace policy of the caller. A user who
-- belongs to several workspaces is held to the shortest window, so a permissive workspace
-- can never extend another workspace's session. Returns 0 when the user has no active
-- workspace policy (the caller then falls back to the IdP token TTL).
CREATE OR REPLACE FUNCTION workspace.effective_session_timeout_minutes(p_user_id uuid)
  RETURNS integer
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT coalesce(min(s.session_timeout_minutes), 0)
  FROM workspace.memberships m
  JOIN workspace.workspaces w
    ON w.id = m.workspace_id
   AND w.status = 'ACTIVE'
  JOIN workspace.security_settings s
    ON s.workspace_id = m.workspace_id
 WHERE m.user_id = p_user_id
   AND m.status = 'ACTIVE'
   AND p_user_id = ops.current_user_id()
$$;

REVOKE ALL ON FUNCTION workspace.effective_session_timeout_minutes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.effective_session_timeout_minutes(uuid) TO krug_app;

COMMENT ON FUNCTION workspace.effective_session_timeout_minutes(uuid) IS
  '#101 strictest ACTIVE workspace session_timeout_minutes for the caller; 0 = no policy';

-- Retention tombstones a BOT message like any other. The V53 shape check requires a body
-- for a live BOT row; a soft-deleted row is a content-free tombstone, so the body may be
-- cleared. The other bot invariants (no impersonation, no plugin payload) are unchanged.
ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_bot_text;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_bot_text
  CHECK (sender_type <> 'BOT'
         OR (type = 'TEXT'
             AND (body_ciphertext IS NOT NULL OR deleted_at IS NOT NULL)
             AND reply_to_id IS NULL AND thread_root_id IS NULL
             AND poll_id IS NULL AND task_id IS NULL AND sticker_id IS NULL));

-- ---------------------------------------------------------------------------------
-- Daily workspace retention run counters (one row per workspace run).
-- ---------------------------------------------------------------------------------
CREATE TABLE workspace.retention_runs (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  retention_days   integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  messages_deleted integer NOT NULL DEFAULT 0 CHECK (messages_deleted >= 0),
  files_deleted    integer NOT NULL DEFAULT 0 CHECK (files_deleted >= 0),
  batches          integer NOT NULL DEFAULT 0 CHECK (batches >= 0),
  status           text NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  -- Only a bounded machine code (exception class), never a message, SQL or content.
  error_code       text CHECK (error_code IS NULL OR char_length(error_code) <= 120)
);

CREATE INDEX ix_retention_runs_ws_started
  ON workspace.retention_runs (workspace_id, started_at DESC, id DESC);

ALTER TABLE workspace.retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.retention_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY p_retention_runs_tenant ON workspace.retention_runs
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON workspace.retention_runs TO krug_app;

COMMENT ON TABLE workspace.retention_runs IS
  '#101 per-workspace retention counters; ids/counters only, never message or file content.';

-- The scheduled job runs per workspace in a tenant-scoped transaction. It needs the list of
-- workspaces with a retention policy; this function is gated on the transaction-local
-- retention worker role and returns settings values only.
CREATE OR REPLACE FUNCTION workspace.retention_targets(p_limit integer)
  RETURNS TABLE (
    workspace_id   uuid,
    retention_days integer)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
SELECT s.workspace_id, s.retention_days
  FROM workspace.security_settings s
  JOIN workspace.workspaces w
    ON w.id = s.workspace_id
   AND w.status = 'ACTIVE'
 WHERE ops.current_worker_role() = 'retention'
 ORDER BY s.workspace_id
 LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION workspace.retention_targets(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.retention_targets(integer) TO krug_app;

COMMENT ON FUNCTION workspace.retention_targets(integer) IS
  '#101 ACTIVE workspaces with a retention policy; retention worker role only';

-- ---------------------------------------------------------------------------------
-- Retention scans. The message table is range-partitioned; a partitioned index is
-- inherited by every current and future partition. ensure_partition() is updated so a
-- partition created after this migration gets the same index.
-- ---------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_messages_ws_created
  ON message.messages (workspace_id, created_at);

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
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON message.%I (workspace_id, created_at)',
    'ix_' || part_name || '_ws_created', part_name);
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

CREATE INDEX IF NOT EXISTS ix_attachments_ws_created_live
  ON file.attachments (workspace_id, created_at)
  WHERE status <> 'DELETED';

-- Forward-only rollback plan:
--   DROP INDEX file.ix_attachments_ws_created_live;
--   DROP INDEX message.ix_messages_ws_created;
--   -- restore the V4 ensure_partition() body (without ix_*_ws_created)
--   DROP FUNCTION workspace.retention_targets(integer);
--   DROP FUNCTION workspace.effective_session_timeout_minutes(uuid);
--   DROP TABLE workspace.retention_runs;
--   DROP TABLE auth.session_activity;
--   ALTER TABLE workspace.dlp_policies DROP COLUMN max_file_size_bytes, DROP COLUMN scope;
-- Retention counters, session activity and DLP scope/size settings are lost on rollback;
-- messages, files, DLP rules and existing audit rows are untouched.
