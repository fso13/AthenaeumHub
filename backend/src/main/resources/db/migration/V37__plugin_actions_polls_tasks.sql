-- D1.1 (#76): executable *actions* of the already-gated plugins polls/tasks, plus the
-- server-side storage for translation audit. Nothing here executes plugin code, installs
-- anything or calls an external provider.
--
-- Scope and invariants:
--   * plugin.polls/poll_options/poll_votes are server-side managed-chat metadata only.
--     E2EE chats can never enable a MANAGED-only plugin, so no ciphertext is touched.
--   * one vote per user per poll is a primary key (poll_id, user_id); changing a vote
--     updates option_id instead of inserting a second row.
--   * composite foreign keys include workspace_id/chat_id, so a vote can never point at
--     an option from another poll/chat/workspace (FK checks bypass RLS otherwise).
--   * plugin.tasks is chat-scoped; assignee/due are optional metadata. completed_by/
--     completed_at are forced by a CHECK to agree with done.
--   * Every table is FORCE RLS by ops.current_workspace_id(); krug_app gets only the
--     minimum DML it needs (no DELETE: there are no delete endpoints in this slice).
--   * text columns are plain text: controls/HTML brackets are rejected by CHECK as a DB
--     backstop; the application additionally trims and validates them.

-- ---------------------------------------------------------------------------
-- Polls
-- ---------------------------------------------------------------------------

CREATE TABLE plugin.polls (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  creator_id   uuid NOT NULL,
  question     text NOT NULL
               CHECK (char_length(question) BETWEEN 1 AND 500
                      AND question !~ '[[:cntrl:]<>]'),
  closed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Needed by the composite FKs below; it also proves the poll belongs to the same
  -- workspace/chat as its options and votes.
  CONSTRAINT uq_plugin_polls_ws_chat_id UNIQUE (workspace_id, chat_id, id)
);

CREATE INDEX ix_plugin_polls_ws_chat_created
  ON plugin.polls (workspace_id, chat_id, created_at DESC, id DESC);

ALTER TABLE plugin.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.polls FORCE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_polls_tenant ON plugin.polls
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON plugin.polls TO krug_app;

CREATE TABLE plugin.poll_options (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL,
  poll_id      uuid NOT NULL,
  position     integer NOT NULL CHECK (position BETWEEN 0 AND 9),
  text         text NOT NULL
               CHECK (char_length(text) BETWEEN 1 AND 200
                      AND text !~ '[[:cntrl:]<>]'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_plugin_poll_options_position UNIQUE (poll_id, position),
  -- The four-column unique key is the parent key of poll_votes: an option id can only
  -- be used by a vote that carries the same workspace/chat/poll.
  CONSTRAINT uq_plugin_poll_options_ws_chat_poll_id
    UNIQUE (workspace_id, chat_id, poll_id, id),
  CONSTRAINT fk_plugin_poll_options_poll
    FOREIGN KEY (workspace_id, chat_id, poll_id)
    REFERENCES plugin.polls (workspace_id, chat_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_plugin_poll_options_ws_chat_poll
  ON plugin.poll_options (workspace_id, chat_id, poll_id, position);

ALTER TABLE plugin.poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.poll_options FORCE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_poll_options_tenant ON plugin.poll_options
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT ON plugin.poll_options TO krug_app;

CREATE TABLE plugin.poll_votes (
  poll_id      uuid NOT NULL,
  option_id    uuid NOT NULL,
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id),
  CONSTRAINT fk_plugin_poll_votes_option
    FOREIGN KEY (workspace_id, chat_id, poll_id, option_id)
    REFERENCES plugin.poll_options (workspace_id, chat_id, poll_id, id)
    ON DELETE CASCADE
);

CREATE INDEX ix_plugin_poll_votes_ws_chat_poll_option
  ON plugin.poll_votes (workspace_id, chat_id, poll_id, option_id);

ALTER TABLE plugin.poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.poll_votes FORCE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_poll_votes_tenant ON plugin.poll_votes
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON plugin.poll_votes TO krug_app;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

CREATE TABLE plugin.tasks (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  creator_id   uuid NOT NULL,
  assignee_id  uuid,
  title        text NOT NULL
               CHECK (char_length(title) BETWEEN 1 AND 500
                      AND title !~ '[[:cntrl:]<>]'),
  due_at       timestamptz,
  done         boolean NOT NULL DEFAULT false,
  completed_by uuid,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_plugin_tasks_done_completed CHECK (
    (done AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
    OR (NOT done AND completed_by IS NULL AND completed_at IS NULL)
  )
);

CREATE INDEX ix_plugin_tasks_ws_chat_done_created
  ON plugin.tasks (workspace_id, chat_id, done, created_at DESC, id DESC);
CREATE INDEX ix_plugin_tasks_ws_chat_assignee
  ON plugin.tasks (workspace_id, chat_id, assignee_id);

ALTER TABLE plugin.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_tasks_tenant ON plugin.tasks
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON plugin.tasks TO krug_app;

COMMENT ON TABLE plugin.polls IS
  'D1.1 (#76) managed-chat polls; plugin code is never executed and no E2EE content is stored.';
COMMENT ON TABLE plugin.poll_options IS
  'D1.1 (#76) poll options; composite FK binds each option to its poll/workspace/chat.';
COMMENT ON TABLE plugin.poll_votes IS
  'D1.1 (#76) one vote per (poll,user); option changes UPDATE the row.';
COMMENT ON TABLE plugin.tasks IS
  'D1.1 (#76) chat-scoped tasks; assignee/due are optional metadata only.';
COMMENT ON COLUMN plugin.poll_votes.updated_at IS
  'Last vote change of this user; unchanged repeats do not touch it.';
COMMENT ON COLUMN plugin.tasks.completed_by IS
  'Actor that last completed/reopened the task; no FK so user deletion keeps the row.';

-- Forward-only rollback plan (destructive: poll/task data is lost):
--   DROP TABLE plugin.poll_votes;
--   DROP TABLE plugin.poll_options;
--   DROP TABLE plugin.polls;
--   DROP TABLE plugin.tasks;
-- chat/message/file rows and plugin.catalog/chat.chat_plugins are untouched.
