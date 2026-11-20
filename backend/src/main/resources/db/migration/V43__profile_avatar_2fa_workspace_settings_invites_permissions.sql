-- P0-4 / GitHub #82: profile avatar, TOTP two-factor authentication, workspace
-- settings/logo/invites and the workspace role-permission matrix.
--
-- Additive only. No existing column, policy or grant is changed and RLS is not weakened:
--   * auth.users.avatar_file_id references an existing managed image attachment
--     (file.attachments). The application validates ownership, the image kind and the
--     CLEAN scan gate before writing the reference; ON DELETE SET NULL avoids a dangling
--     pointer when an attachment row is physically removed.
--   * auth.user_totp stores the RFC 6238 secret only as AES-256-GCM ciphertext
--     (secret_ciphertext). No plaintext secret, QR payload or verification code is ever
--     written to PostgreSQL, audit or logs. The row is self-scoped FORCE RLS exactly like
--     auth.users.
--   * auth.user_recovery_codes stores only SHA-256 hex digests of one-time recovery codes;
--     a digest is deleted on use. Self-scoped FORCE RLS.
--   * workspace.workspaces gains description and logo_file_id (same CLEAN-image rule as
--     the channel cover from V41).
--   * workspace.role_permissions is the effective workspace-level matrix for
--     OWNER/ADMIN/MEMBER (OWNER rows are immutable and always true). Tenant RLS.
--   * workspace.invites stores only the SHA-256 hex digest of the opaque email-link token;
--     the raw token is returned once by POST /workspaces/{id}/invites and is never
--     recoverable. Tenant RLS for the management surface.
--   * workspace.accept_invite(...) is the only cross-tenant lookup: the accept URL carries
--     no workspace id, so the SECURITY DEFINER function locks the invite row, enforces
--     expiry/max_uses atomically and re-checks the authenticated caller. It follows the
--     V24/V27/V40 pattern (owner can read the referenced FORCE-RLS tables; production DBAs
--     provision the same split) and still verifies ops.current_user_id() so a caller who
--     bypasses HTTP gets no rows and no membership.
--
-- No email is sent by this slice: the invite token/accept URL is returned to the inviting
-- OWNER/ADMIN and is shared out of band.

-- ---------------------------------------------------------------------------------
-- Profile avatar (existing CLEAN image attachment).
-- ---------------------------------------------------------------------------------
ALTER TABLE auth.users
  ADD COLUMN avatar_file_id  uuid,
  ADD COLUMN avatar_updated_at timestamptz,
  ADD CONSTRAINT fk_users_avatar_file
      FOREIGN KEY (avatar_file_id) REFERENCES file.attachments(id) ON DELETE SET NULL;

COMMENT ON COLUMN auth.users.avatar_file_id IS
  'P0-4 avatar: CLEAN image attachment owned by the user; ON DELETE SET NULL.';
COMMENT ON COLUMN auth.users.avatar_updated_at IS
  'P0-4 last avatar change; NULL until an avatar is set for the first time.';

-- ---------------------------------------------------------------------------------
-- TOTP authenticator (RFC 6238) — encrypted secret only.
-- ---------------------------------------------------------------------------------
CREATE TABLE auth.user_totp (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- [version=1][12-byte nonce][AES-256-GCM ciphertext+tag]; never plaintext.
  secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) >= 29),
  algorithm        text NOT NULL DEFAULT 'SHA1' CHECK (algorithm = 'SHA1'),
  digits           smallint NOT NULL DEFAULT 6 CHECK (digits = 6),
  period_seconds   smallint NOT NULL DEFAULT 30 CHECK (period_seconds = 30),
  -- Last accepted TOTP time step; a replayed code is rejected. 0 until first use.
  last_used_step   bigint NOT NULL DEFAULT 0 CHECK (last_used_step >= 0),
  -- NULL = setup started but not confirmed; set once /me/2fa/verify accepts a code.
  enabled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth.user_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.user_totp FORCE ROW LEVEL SECURITY;
CREATE POLICY p_user_totp_self ON auth.user_totp
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.user_totp TO krug_app;

COMMENT ON TABLE auth.user_totp IS
  'P0-4 per-user TOTP authenticator; AES-GCM ciphertext and last accepted step only.';
COMMENT ON COLUMN auth.user_totp.secret_ciphertext IS
  'AES-256-GCM ciphertext (version/nonce/tag); the plaintext secret never reaches storage.';

-- ---------------------------------------------------------------------------------
-- Recovery codes — one-time, hashed.
-- ---------------------------------------------------------------------------------
CREATE TABLE auth.user_recovery_codes (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- SHA-256 hex of "2fa-recovery|<user_id>|<NORMALIZED_CODE>".
  code_hash  text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE INDEX ix_user_recovery_codes_unused
  ON auth.user_recovery_codes (user_id)
  WHERE used_at IS NULL;

ALTER TABLE auth.user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.user_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY p_user_recovery_codes_self ON auth.user_recovery_codes
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.user_recovery_codes TO krug_app;

COMMENT ON TABLE auth.user_recovery_codes IS
  'P0-4 one-time recovery codes; only SHA-256 digests, deleted/marked used on consumption.';

-- ---------------------------------------------------------------------------------
-- Workspace settings: description + logo.
-- ---------------------------------------------------------------------------------
ALTER TABLE workspace.workspaces
  ADD COLUMN description  text,
  ADD COLUMN logo_file_id uuid,
  ADD CONSTRAINT ck_workspaces_description_length
      CHECK (description IS NULL OR char_length(description) <= 500),
  ADD CONSTRAINT fk_workspaces_logo_file
      FOREIGN KEY (logo_file_id) REFERENCES file.attachments(id) ON DELETE SET NULL;

COMMENT ON COLUMN workspace.workspaces.description IS
  'P0-4 plain-text workspace description, at most 500 characters; NULL = empty.';
COMMENT ON COLUMN workspace.workspaces.logo_file_id IS
  'P0-4 workspace logo: CLEAN image attachment in this workspace; ON DELETE SET NULL.';

-- ---------------------------------------------------------------------------------
-- Workspace role-permission matrix (OWNER/ADMIN/MEMBER).
-- ---------------------------------------------------------------------------------
CREATE TABLE workspace.role_permissions (
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
  permission   text NOT NULL CHECK (permission IN (
                  'manage_workspace',
                  'manage_members',
                  'manage_invites',
                  'manage_permissions',
                  'view_audit',
                  'manage_security')),
  allowed      boolean NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, role, permission)
);

ALTER TABLE workspace.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY p_role_permissions_tenant ON workspace.role_permissions
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON workspace.role_permissions TO krug_app;

COMMENT ON TABLE workspace.role_permissions IS
  'P0-4 effective workspace rights per role; OWNER rows are immutable and always true.';

-- Seed every existing workspace with the documented defaults. The application inserts the
-- same rows for workspaces created after this migration (idempotent ON CONFLICT).
INSERT INTO workspace.role_permissions (workspace_id, role, permission, allowed)
SELECT w.id, d.role, d.permission, d.allowed
  FROM workspace.workspaces w
 CROSS JOIN (VALUES
        ('OWNER',  'manage_workspace',   true),
        ('OWNER',  'manage_members',     true),
        ('OWNER',  'manage_invites',     true),
        ('OWNER',  'manage_permissions', true),
        ('OWNER',  'view_audit',         true),
        ('OWNER',  'manage_security',    true),
        ('ADMIN',  'manage_workspace',   true),
        ('ADMIN',  'manage_members',     true),
        ('ADMIN',  'manage_invites',     true),
        ('ADMIN',  'manage_permissions', true),
        ('ADMIN',  'view_audit',         true),
        ('ADMIN',  'manage_security',    true),
        ('MEMBER', 'manage_workspace',   false),
        ('MEMBER', 'manage_members',     false),
        ('MEMBER', 'manage_invites',     false),
        ('MEMBER', 'manage_permissions', false),
        ('MEMBER', 'view_audit',         false),
        ('MEMBER', 'manage_security',    false)
     ) AS d(role, permission, allowed)
ON CONFLICT (workspace_id, role, permission) DO NOTHING;

-- ---------------------------------------------------------------------------------
-- Workspace invite links (email link token; no email is sent by the backend).
-- ---------------------------------------------------------------------------------
CREATE TABLE workspace.invites (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  -- SHA-256 hex of the opaque token; the raw token never reaches the database.
  token_hash   text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  -- OWNER is intentionally not assignable through an invite link.
  role         text NOT NULL CHECK (role IN ('ADMIN', 'MEMBER', 'GUEST')),
  created_by   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  max_uses     integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000),
  used_count   integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workspace_invites_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_workspace_invites_uses
      CHECK (max_uses IS NULL OR used_count <= max_uses)
);

CREATE INDEX ix_workspace_invites_ws_created
  ON workspace.invites (workspace_id, created_at DESC, id DESC);
CREATE INDEX ix_workspace_invites_token_hash
  ON workspace.invites (token_hash);

ALTER TABLE workspace.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.invites FORCE ROW LEVEL SECURITY;
CREATE POLICY p_workspace_invites_tenant ON workspace.invites
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.invites TO krug_app;

COMMENT ON TABLE workspace.invites IS
  'P0-4 workspace invite links; token_hash only, the raw token is never persisted.';
COMMENT ON COLUMN workspace.invites.token_hash IS
  'SHA-256 hex of the opaque invite token; never exposed through the API.';

-- ---------------------------------------------------------------------------------
-- Accept an invite (token lookup + membership) for the authenticated caller.
--
-- Outcomes (mapped to HTTP in the workspace application layer):
--   OK                   — joined, or already an ACTIVE member (already_member = true);
--   NOT_FOUND            — unknown token hash (404, existence is not disclosed);
--   FORBIDDEN            — caller is not an ACTIVE auth.users row / GUC mismatch (403);
--   WORKSPACE_UNAVAILABLE— workspace is not ACTIVE (404);
--   REVOKED / EXPIRED / EXHAUSTED — 410 with a distinct code.
--
-- An existing ACTIVE member is answered before expiry/revocation so a repeated accept is
-- idempotent: used_count is not incremented and the application skips the audit event.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.accept_invite(p_token_hash text, p_user_id uuid)
  RETURNS TABLE (
    outcome text,
    invite_id uuid,
    workspace_id uuid,
    role text,
    already_member boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_invite workspace.invites%ROWTYPE;
  v_workspace_status text;
  v_member_status text;
  v_member_role text;
BEGIN
  IF p_user_id IS DISTINCT FROM ops.current_user_id() THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM auth.users u
     WHERE u.id = p_user_id
       AND u.status = 'ACTIVE'
  ) THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  -- FOR UPDATE serializes concurrent accepts of the same link, so max_uses is exact.
  SELECT *
    INTO v_invite
    FROM workspace.invites
   WHERE token_hash = p_token_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  SELECT w.status
    INTO v_workspace_status
    FROM workspace.workspaces w
   WHERE w.id = v_invite.workspace_id;

  IF NOT FOUND OR v_workspace_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'WORKSPACE_UNAVAILABLE'::text, v_invite.id,
                        v_invite.workspace_id, NULL::text, false;
    RETURN;
  END IF;

  SELECT m.status, m.role
    INTO v_member_status, v_member_role
    FROM workspace.memberships m
   WHERE m.workspace_id = v_invite.workspace_id
     AND m.user_id = p_user_id;

  IF v_member_status = 'ACTIVE' THEN
    RETURN QUERY SELECT 'OK'::text, v_invite.id, v_invite.workspace_id,
                        v_member_role, true;
    RETURN;
  END IF;

  IF v_invite.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'REVOKED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.role, false;
    RETURN;
  END IF;

  IF v_invite.expires_at <= now() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.role, false;
    RETURN;
  END IF;

  IF v_invite.max_uses IS NOT NULL AND v_invite.used_count >= v_invite.max_uses THEN
    RETURN QUERY SELECT 'EXHAUSTED'::text, v_invite.id, v_invite.workspace_id,
                        v_invite.role, false;
    RETURN;
  END IF;

  INSERT INTO workspace.memberships
      (workspace_id, user_id, role, status, joined_at, updated_at)
  VALUES (v_invite.workspace_id, p_user_id, v_invite.role, 'ACTIVE', now(), now())
  -- Constraint name because RETURNS TABLE exposes workspace_id/user_id as PL/pgSQL
  -- variables, which would make a bare target list ambiguous.
  ON CONFLICT ON CONSTRAINT memberships_pkey DO UPDATE
     SET role = EXCLUDED.role,
         status = 'ACTIVE',
         joined_at = EXCLUDED.joined_at,
         updated_at = now();

  UPDATE workspace.invites
     SET used_count = used_count + 1
   WHERE id = v_invite.id;

  RETURN QUERY SELECT 'OK'::text, v_invite.id, v_invite.workspace_id,
                      v_invite.role, false;
END
$$;

REVOKE ALL ON FUNCTION workspace.accept_invite(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.accept_invite(text, uuid) TO krug_app;

COMMENT ON FUNCTION workspace.accept_invite(text, uuid) IS
  'P0-4 join a workspace by invite token hash: caller/workspace checks, row lock for max_uses, idempotent for existing ACTIVE members';
