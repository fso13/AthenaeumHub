-- #100: email-bound workspace invitations and the post-registration claim.
--
-- Additive only. No existing column, policy, grant or function signature is changed
-- destructively:
--   * workspace.invites gains a nullable, normalized `email`. A non-null value marks a
--     single-use invitation that only the matching account may accept; link invitations
--     keep `email = NULL` and their multi-use max_uses semantics. The raw token is still
--     never persisted: only token_hash exists and it is sent to the recipient by email.
--   * workspace.accept_invite(text, uuid) keeps its signature/outcomes and gains one new
--     outcome EMAIL_MISMATCH. An email-bound invite is compared case-insensitively with
--     auth.users.email (citext); a mismatch does not consume the invite.
--   * workspace.preview_invite(text) is the only anonymous read of an invite. It is
--     SECURITY DEFINER like accept_invite (the preview URL carries no workspace id), is
--     keyed by the SHA-256 token hash, and returns workspace name/slug/role/email-bound
--     flags only - never the token, hash or the invited address.
--   * auth.email_verifications gains invite_token_hash so registration can carry an invite
--     token without storing the raw bearer secret. The hash is consumed after the email
--     code is verified; the workspace claim is idempotent and best-effort.
--
-- No email is stored in the audit chain: only invite/user/workspace ids and the role.

-- ---------------------------------------------------------------------------------
-- Email-bound invites (single use).
-- ---------------------------------------------------------------------------------
ALTER TABLE workspace.invites
  ADD COLUMN email citext,
  ADD CONSTRAINT ck_workspace_invites_email_length
      CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
  -- An email-bound invite is always single-use. Link invites (email IS NULL) keep
  -- max_uses NULL (unlimited) or 1..1000.
  ADD CONSTRAINT ck_workspace_invites_email_single_use
      CHECK (email IS NULL OR max_uses = 1);

CREATE INDEX ix_workspace_invites_ws_email
  ON workspace.invites (workspace_id, email)
  WHERE email IS NOT NULL;

COMMENT ON COLUMN workspace.invites.email IS
  '#100 normalized lower-case recipient address of a single-use email invite; NULL = link invite.';

-- ---------------------------------------------------------------------------------
-- Registration claim: hash only, never the raw invite token.
-- ---------------------------------------------------------------------------------
ALTER TABLE auth.email_verifications
  ADD COLUMN invite_token_hash text
      CHECK (invite_token_hash IS NULL OR invite_token_hash ~ '^[a-f0-9]{64}$');

COMMENT ON COLUMN auth.email_verifications.invite_token_hash IS
  '#100 SHA-256 hex of a workspace invite token supplied at registration; the raw token is never stored.';

-- ---------------------------------------------------------------------------------
-- Accept an invite, now with the email binding.
--
-- Outcomes (mapped to HTTP in the workspace application layer):
--   OK                   - joined, or already an ACTIVE member (already_member = true);
--   NOT_FOUND            - unknown token hash (404, existence is not disclosed);
--   FORBIDDEN            - caller is not an ACTIVE auth.users row / GUC mismatch (403);
--   WORKSPACE_UNAVAILABLE- workspace is not ACTIVE (404);
--   REVOKED / EXPIRED / EXHAUSTED - 410 with a distinct code;
--   EMAIL_MISMATCH       - the invite is bound to another address (403, not consumed).
--
-- An existing ACTIVE member is answered before the binding/expiry/revocation checks so a
-- repeated accept stays idempotent. The email comparison is case-insensitive because both
-- workspace.invites.email and auth.users.email are citext; text normalization is explicit
-- so the function does not depend on the caller's search_path.
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
  v_user_email text;
BEGIN
  IF p_user_id IS DISTINCT FROM ops.current_user_id() THEN
    RETURN QUERY SELECT 'FORBIDDEN'::text, NULL::uuid, NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  SELECT u.email::text
    INTO v_user_email
    FROM auth.users u
   WHERE u.id = p_user_id
     AND u.status = 'ACTIVE';

  IF NOT FOUND THEN
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

  -- #100: an email-bound invite is accepted only by the invited address. The invite is
  -- intentionally left unconsumed, so the legitimate recipient can still use it.
  IF v_invite.email IS NOT NULL
     AND lower(v_invite.email::text) IS DISTINCT FROM lower(v_user_email) THEN
    RETURN QUERY SELECT 'EMAIL_MISMATCH'::text, v_invite.id, v_invite.workspace_id,
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
  '#100 join by invite token hash: caller/workspace/expiry/max_uses/email-binding checks, row lock, idempotent for existing ACTIVE members';

-- ---------------------------------------------------------------------------------
-- Anonymous invite preview.
--
-- The preview URL (GET /workspace-invites/{token}) has no workspace id and no session, so
-- the SECURITY DEFINER function resolves the token hash and returns only display metadata.
-- The token is a 256-bit bearer secret; an unknown hash is a 404 and the invited address,
-- token hash and raw token are never returned. Revoked/expired/exhausted invites answer
-- distinct 410 outcomes from the application layer.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workspace.preview_invite(p_token_hash text)
  RETURNS TABLE (
    outcome text,
    workspace_name text,
    workspace_slug text,
    role text,
    email_bound boolean,
    expires_at timestamptz)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_invite workspace.invites%ROWTYPE;
  v_workspace_status text;
  v_workspace_name text;
  v_workspace_slug text;
BEGIN
  SELECT *
    INTO v_invite
    FROM workspace.invites
   WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
                        false, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT w.status, w.name, w.slug::text
    INTO v_workspace_status, v_workspace_name, v_workspace_slug
    FROM workspace.workspaces w
   WHERE w.id = v_invite.workspace_id;

  IF NOT FOUND OR v_workspace_status <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'WORKSPACE_UNAVAILABLE'::text, NULL::text, NULL::text,
                        NULL::text, false, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_invite.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'REVOKED'::text, v_workspace_name, v_workspace_slug,
                        v_invite.role, v_invite.email IS NOT NULL, v_invite.expires_at;
    RETURN;
  END IF;

  IF v_invite.expires_at <= now() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, v_workspace_name, v_workspace_slug,
                        v_invite.role, v_invite.email IS NOT NULL, v_invite.expires_at;
    RETURN;
  END IF;

  IF v_invite.max_uses IS NOT NULL AND v_invite.used_count >= v_invite.max_uses THEN
    RETURN QUERY SELECT 'EXHAUSTED'::text, v_workspace_name, v_workspace_slug,
                        v_invite.role, v_invite.email IS NOT NULL, v_invite.expires_at;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'OK'::text, v_workspace_name, v_workspace_slug, v_invite.role,
                      v_invite.email IS NOT NULL, v_invite.expires_at;
END
$$;

REVOKE ALL ON FUNCTION workspace.preview_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.preview_invite(text) TO krug_app;

COMMENT ON FUNCTION workspace.preview_invite(text) IS
  '#100 anonymous invite preview by token hash: workspace name/slug/role/email-bound only; no token, hash or address';
