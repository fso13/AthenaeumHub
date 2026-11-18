-- E6-B: in-app notifications and per-user notification preferences.
--
-- Ownership:
--   * notification.notifications is a per-user inbox (RLS by user_id). Rows are created
--     by the post-commit message fan-out; the sender is never notified and dedupe_key
--     makes repeated message.created deliveries harmless.
--   * notification.notification_preferences stores per-user/per-workspace/per-chat
--     channel+type preferences. Nullable chat_id means "global for this workspace".
--   * Retention is 90 days (SYSTEM-ANALYSIS §6.3); the retention worker may delete
--     expired rows across users through the explicit worker-role policy.
--
-- Privacy: there is intentionally no message text column. E6 notifications are generic
-- ("Новое сообщение") and `body` stays NULL for both MANAGED and E2EE chats.

CREATE SCHEMA IF NOT EXISTS notification;
GRANT USAGE ON SCHEMA notification TO krug_app;

CREATE TABLE notification.notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id     uuid REFERENCES chat.chats(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('MESSAGE', 'MENTION', 'SYSTEM')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body        text,
  dedupe_key  text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 400),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Stable inbox order and cursor pagination: (created_at DESC, id DESC).
CREATE INDEX ix_notifications_user_created
  ON notification.notifications (user_id, created_at DESC, id DESC);

-- Unread badge lookup stays cheap even for a long inbox.
CREATE INDEX ix_notifications_user_unread
  ON notification.notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE UNIQUE INDEX uq_notifications_dedupe
  ON notification.notifications (dedupe_key);

-- Retention: delete the oldest expired rows in bounded batches.
CREATE INDEX ix_notifications_created
  ON notification.notifications (created_at);

CREATE TABLE notification.notification_preferences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id      uuid REFERENCES chat.chats(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('MESSAGE', 'MENTION', 'SYSTEM')),
  channel      text NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL')),
  mode         text NOT NULL CHECK (mode IN ('ALL', 'MENTIONS', 'MUTE')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT is required: a "global" row has chat_id = NULL and must still
  -- conflict with itself on upsert (PostgreSQL 15+; compose/test images are PG16).
  CONSTRAINT uq_notification_preferences_scope
    UNIQUE NULLS NOT DISTINCT (user_id, workspace_id, chat_id, type, channel)
);

CREATE INDEX ix_notification_preferences_user
  ON notification.notification_preferences (user_id);

ALTER TABLE notification.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY p_notifications_owner ON notification.notifications
  USING (
    user_id = ops.current_user_id()
    OR ops.current_worker_role() = 'notification-retention'
  )
  WITH CHECK (
    user_id = ops.current_user_id()
    OR ops.current_worker_role() = 'notification-retention'
  );

ALTER TABLE notification.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY p_notification_preferences_owner ON notification.notification_preferences
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON notification.notifications, notification.notification_preferences
  TO krug_app;

COMMENT ON COLUMN notification.notifications.body IS
  'E6-B: always NULL (E2EE contract and privacy default); never store message text';
COMMENT ON COLUMN notification.notifications.dedupe_key IS
  'E6-D-03: (user_id, chat_id, message_id, type) rendered as a stable string';