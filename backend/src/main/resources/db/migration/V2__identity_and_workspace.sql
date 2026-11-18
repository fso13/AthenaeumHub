-- auth.users / auth.devices and workspace.workspaces / workspace.memberships.
-- Tenant tables carry workspace_id where applicable and are protected by RLS.

CREATE TABLE auth.users (
  id            uuid PRIMARY KEY,
  email         citext UNIQUE,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_users_created_at ON auth.users (created_at);

CREATE TABLE auth.devices (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  platform           text NOT NULL CHECK (platform IN ('WEB', 'DESKTOP', 'MOBILE')),
  app_version        text NOT NULL DEFAULT 'dev',
  -- E2EE keys are out of scope for B-01, therefore nullable (documented deviation).
  identity_public_key bytea,
  identity_key_alg   text NOT NULL DEFAULT 'Ed25519',
  key_generation     integer NOT NULL DEFAULT 1 CHECK (key_generation > 0),
  status             text NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  UNIQUE (user_id, id)
);

CREATE INDEX ix_devices_user_status ON auth.devices (user_id, status);

CREATE TABLE workspace.workspaces (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug          citext NOT NULL UNIQUE,
  security_mode text NOT NULL CHECK (security_mode IN ('MANAGED', 'E2EE')),
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_by    uuid,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_workspaces_security_mode ON workspace.workspaces (security_mode);
CREATE INDEX ix_workspaces_created_at ON workspace.workspaces (created_at);

CREATE TABLE workspace.memberships (
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'GUEST')),
  status       text NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('INVITED', 'ACTIVE', 'REMOVED')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX ix_memberships_user_status ON workspace.memberships (user_id, status);
CREATE UNIQUE INDEX ux_memberships_one_owner
  ON workspace.memberships (workspace_id)
  WHERE role = 'OWNER';

-- RLS: work on the workspace of the current transaction; memberships are additionally
-- visible to their own user so /sync can resolve access before workspace context exists.
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
CREATE POLICY p_users_self ON auth.users
  USING (id = ops.current_user_id())
  WITH CHECK (id = ops.current_user_id());

ALTER TABLE auth.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.devices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_devices_self ON auth.devices
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

ALTER TABLE workspace.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY p_workspaces_tenant ON workspace.workspaces
  USING (id = ops.current_workspace_id())
  WITH CHECK (id = ops.current_workspace_id());

ALTER TABLE workspace.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY p_memberships_tenant ON workspace.memberships
  USING (
    workspace_id = ops.current_workspace_id()
    OR user_id = ops.current_user_id()
  )
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users, auth.devices TO krug_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace.workspaces, workspace.memberships TO krug_app;
