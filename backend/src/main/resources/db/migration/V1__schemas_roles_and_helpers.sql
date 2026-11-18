-- B-01 foundation: extensions, module schemas, DB roles, RLS helper functions.
--
-- Roles:
--   krug_migrator - owns schema objects, runs Flyway (superuser/createrole in dev/test).
--   krug_app      - runtime role for the application; subject to RLS.
--
-- NOTE: creating roles requires CREATEROLE/superuser. In dev and Testcontainers the
-- migration user is superuser. On a managed PostgreSQL the DBA must pre-create the
-- roles and this block becomes a no-op.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS workspace;
CREATE SCHEMA IF NOT EXISTS chat;
CREATE SCHEMA IF NOT EXISTS message;
CREATE SCHEMA IF NOT EXISTS ops;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'krug_migrator') THEN
    -- Owned by the DBA in production; NOLOGIN here only documents the role.
    CREATE ROLE krug_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'krug_app') THEN
    CREATE ROLE krug_app LOGIN PASSWORD 'krug_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA auth, workspace, chat, message, ops TO krug_app;
GRANT USAGE ON SCHEMA ops TO krug_app;

-- Transaction-local tenant context. Set with set_config(..., true) by TenantTransactions.
CREATE OR REPLACE FUNCTION ops.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION ops.current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION ops.current_request_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.request_id', true), '') $$;

GRANT EXECUTE ON FUNCTION ops.current_user_id() TO krug_app;
GRANT EXECUTE ON FUNCTION ops.current_workspace_id() TO krug_app;
GRANT EXECUTE ON FUNCTION ops.current_request_id() TO krug_app;
