-- B-04: OIDC identities, audit trail and the RLS policies needed to resolve a
-- Keycloak principal without a workspace_id claim.
--
-- Design notes (documented in backend/README.md):
--   * auth.user_identities maps (provider, subject) -> local auth.users row. The local
--     user id is deterministic for a given (provider, subject), which makes JIT
--     provisioning idempotent under concurrency and lets RLS be enabled from the start.
--   * audit.audit_events is append-only and hash-chained per scope ("user:<id>" before a
--     workspace exists, "workspace:<id>" afterwards). Monthly partitions, anchors and
--     export are E8 scope; B-04 only needs the append path.

CREATE TABLE auth.user_identities (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
);

CREATE INDEX ix_user_identities_user ON auth.user_identities (user_id);

ALTER TABLE auth.user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.user_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY p_user_identities_self ON auth.user_identities
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, UPDATE ON auth.user_identities TO krug_app;

-- /me lists active memberships. The original workspace policy only exposes the workspace
-- selected by app.workspace_id, which is unknown before the user picks one. This policy is
-- additive (permissive OR): a user can read a workspace only through their own ACTIVE
-- membership, and membership RLS already limits rows to the current user.
CREATE POLICY p_workspaces_member_read ON workspace.workspaces
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM workspace.memberships m
       WHERE m.workspace_id = workspace.workspaces.id
         AND m.user_id = ops.current_user_id()
         AND m.status = 'ACTIVE'
    )
  );

-- Keycloak access tokens do not carry workspace_id (SYSTEM-ANALYSIS §11.5), so chat
-- endpoints resolve the workspace from the chat resource. These read-only policies let a
-- member see their own membership row and the chats they belong to before the workspace
-- GUC is known. They are permissive additions to the existing tenant policies.
CREATE POLICY p_chat_members_self_read ON chat.chat_members
  FOR SELECT
  USING (user_id = ops.current_user_id());

CREATE POLICY p_chats_member_read ON chat.chats
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM chat.chat_members cm
       WHERE cm.chat_id = chat.chats.id
         AND cm.user_id = ops.current_user_id()
         AND cm.status = 'ACTIVE'
    )
  );

CREATE SCHEMA IF NOT EXISTS audit;
GRANT USAGE ON SCHEMA audit TO krug_app;

CREATE TABLE audit.audit_events (
  id          uuid PRIMARY KEY,
  -- "user:<uuid>" for identity events, "workspace:<uuid>" for tenant events.
  scope_key   text NOT NULL,
  workspace_id uuid,
  seq         bigint NOT NULL CHECK (seq > 0),
  actor_type  text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'PLUGIN', 'PLATFORM')),
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   uuid,
  request_id  text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   bytea NOT NULL,
  hash        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_key, seq)
);

CREATE INDEX ix_audit_events_workspace ON audit.audit_events (workspace_id, created_at DESC);
CREATE INDEX ix_audit_events_actor ON audit.audit_events (actor_id, created_at DESC);

CREATE TABLE audit.audit_chain (
  scope_key  text PRIMARY KEY,
  last_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_hash  bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY p_audit_events_scope ON audit.audit_events
  USING (workspace_id = ops.current_workspace_id() OR actor_id = ops.current_user_id())
  WITH CHECK (workspace_id = ops.current_workspace_id() OR actor_id = ops.current_user_id());

-- Append-only: krug_app gets no UPDATE/DELETE on events.
GRANT SELECT, INSERT ON audit.audit_events TO krug_app;
-- The chain head is mutated in the same transaction as the append.
GRANT SELECT, INSERT, UPDATE ON audit.audit_chain TO krug_app;
