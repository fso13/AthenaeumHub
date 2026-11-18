-- Auth BFF: pending email confirmations for self-service registration.
--
-- This is a PRE-AUTH table: registration/verification has no JWT and therefore no
-- app.user_id, so it deliberately has no RLS policy. Access is restricted to the runtime
-- role krug_app (GRANT below); the table is never joined with tenant data.
--
-- Security invariants:
--   * no password (or password hash) is stored here or anywhere in the application DB;
--   * `secret` is the AES-256-GCM encrypted RFC 6238 TOTP secret, never the 6-digit code;
--   * the dev/prod Keycloak user is disabled + emailVerified=false until `consumed_at`;
--   * expired rows are purged by the auth BFF cleanup job (no unbounded PII retention).

CREATE TABLE auth.email_verifications (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  keycloak_user_id  uuid NOT NULL,
  -- [version 1][12-byte nonce][AES-GCM ciphertext + 16-byte tag]; 20-byte secret.
  secret            bytea NOT NULL CHECK (octet_length(secret) >= 49),
  expires_at        timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at       timestamptz,
  last_sent_at      timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX ix_email_verifications_email_created
  ON auth.email_verifications (email, created_at DESC);
CREATE INDEX ix_email_verifications_expiry
  ON auth.email_verifications (expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX ix_email_verifications_consumed
  ON auth.email_verifications (consumed_at)
  WHERE consumed_at IS NOT NULL;

COMMENT ON TABLE auth.email_verifications IS
  'Auth BFF pre-auth email confirmation (TOTP secret encrypted; no password).';
COMMENT ON COLUMN auth.email_verifications.secret IS
  'AES-256-GCM TOTP secret; the 6-digit code itself is never stored.';

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.email_verifications TO krug_app;
