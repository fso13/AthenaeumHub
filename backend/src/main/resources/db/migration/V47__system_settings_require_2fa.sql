-- Server-side 2FA policy (#91): installation-wide "2FA required" switch.
--
-- Additive only. ops.system_settings remains a global singleton (installation
-- configuration, not workspace data) and its grants/RLS posture is unchanged:
--   * require_2fa = false keeps the pre-#91 behaviour: only accounts that opted into a
--     TOTP authenticator are challenged at login.
--   * require_2fa = true makes a second factor mandatory for every interactive login.
--     A user without a confirmed authenticator receives an ENROLL challenge (202, no
--     session) and must finish POST /auth/2fa/enroll/{start,verify}.
--   * The switch is read at login/refresh time (no cached copy in the JWT), so an admin
--     change applies to the next authentication attempt. Existing access tokens are not
--     revoked; refresh of a session that was not completed with a second factor is
--     refused with 403 TWO_FACTOR_REQUIRED, which forces a fresh, compliant login.
--   * No token, TOTP secret, QR payload or code is stored here; the setting is a plain
--     boolean. The default is false so upgrading an existing install never locks users
--     out before they have enrolled.
--
-- Forward-only rollback plan:
--   ALTER TABLE ops.system_settings DROP COLUMN require_2fa;
-- The policy is lost on rollback; the application falls back to its hard-coded false
-- default only after an application rollback.

ALTER TABLE ops.system_settings
  ADD COLUMN require_2fa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN ops.system_settings.require_2fa IS
  'Global interactive-login 2FA policy (#91). false = per-user authenticator only; '
  'true = TOTP challenge or ENROLL challenge for every login, no session before it.';
