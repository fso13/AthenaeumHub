-- E7-B1F: security hardening after E2EE-REVIEW-04.
--
-- P1-06  hard/global uniqueness of the identity key pair (no `status <> 'REVOKED'`
--        predicate): a revoked pair can never be "resurrected" into another account.
-- P2-01  NULL-safe all-or-none CHECK (V16's predicate accepted `NULL` combinations).
-- P2-02  one SQL capability predicate `auth.device_is_e2ee_capable(...)`, matching the
--        domain's Device.isE2eeCapable().
-- P2-03  key_verifications scope trigger also requires target ACTIVE+capable and a
--        verifier device that is ACTIVE.
--
-- Forward-only, written against V1–V16. Migration role: the schema owner (V1). The repair
-- sections temporarily disable FORCE RLS (same reason as V16/P1-05: a non-superuser owner
-- sees zero rows otherwise); FORCE is restored before the constraints are validated.

-- ============================================================================
-- 1. One canonical capability predicate (P2-02).
--    status ACTIVE + alg Ed25519+X25519 + all four key fields present with exact lengths.
--    The domain mirror is Device.isE2eeCapable() — keep them in sync.
-- ============================================================================
CREATE OR REPLACE FUNCTION auth.device_is_e2ee_capable(
    p_status      text,
    p_alg         text,
    p_signing_key bytea,
    p_dh_key      bytea,
    p_binding     bytea,
    p_fingerprint bytea)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_status = 'ACTIVE'
     AND p_alg = 'Ed25519+X25519'
     AND p_signing_key IS NOT NULL AND octet_length(p_signing_key) = 32
     AND p_dh_key IS NOT NULL AND octet_length(p_dh_key) = 32
     AND p_binding IS NOT NULL AND octet_length(p_binding) = 64
     AND p_fingerprint IS NOT NULL AND octet_length(p_fingerprint) = 32
$$;

COMMENT ON FUNCTION auth.device_is_e2ee_capable(text, text, bytea, bytea, bytea, bytea)
  IS 'E2EE capability: ACTIVE + Ed25519+X25519 + IK_sig(32)/IK_dh(32)/binding(64)/fingerprint(32)';

GRANT EXECUTE ON FUNCTION auth.device_is_e2ee_capable(text, text, bytea, bytea, bytea, bytea)
  TO krug_app;

-- ============================================================================
-- 2. Quarantine for identity material removed by the repairs below (no data loss).
--    Owner-only: no GRANT to krug_app. Not RLS-protected because the runtime role has no
--    privileges at all.
-- ============================================================================
CREATE TABLE auth.identity_key_quarantine (
  device_id                   uuid PRIMARY KEY REFERENCES auth.devices(id) ON DELETE CASCADE,
  user_id                     uuid NOT NULL,
  identity_signing_key        bytea,
  identity_dh_key             bytea,
  identity_binding_signature  bytea,
  fingerprint                 bytea,
  identity_key_alg            text NOT NULL,
  device_status               text NOT NULL,
  reason                      text NOT NULL,
  quarantined_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE auth.identity_key_quarantine
  IS 'V17 (P1-06/P2-01): identity material removed from auth.devices to restore the global-uniqueness and all-or-none invariants; kept for audit/forensics.';

-- ============================================================================
-- 3. Repair, then hard global uniqueness + NULL-safe all-or-none (P1-06, P2-01).
--    V16's CHECK is NOT NULL-safe: `octet_length(NULL) = 32` is NULL and a CHECK passes
--    on NULL, so rows with alg='Ed25519+X25519' and any missing field were accepted.
-- ============================================================================
ALTER TABLE auth.devices NO FORCE ROW LEVEL SECURITY;

-- 3a. Quarantine and normalize "impossible" rows the V16 CHECK let through.
INSERT INTO auth.identity_key_quarantine
       (device_id, user_id, identity_signing_key, identity_dh_key,
        identity_binding_signature, fingerprint, identity_key_alg, device_status, reason)
SELECT d.id, d.user_id, d.identity_signing_key, d.identity_dh_key,
       d.identity_binding_signature, d.fingerprint, d.identity_key_alg, d.status,
       'INCOMPLETE_IDENTITY_KEYS'
  FROM auth.devices d
 WHERE (d.identity_key_alg = 'LEGACY'
        AND (d.identity_signing_key IS NOT NULL OR d.identity_dh_key IS NOT NULL
             OR d.identity_binding_signature IS NOT NULL OR d.fingerprint IS NOT NULL))
    OR (d.identity_key_alg = 'Ed25519+X25519'
        AND (d.identity_signing_key IS NULL OR d.identity_dh_key IS NULL
             OR d.identity_binding_signature IS NULL OR d.fingerprint IS NULL
             OR octet_length(d.identity_signing_key) <> 32
             OR octet_length(d.identity_dh_key) <> 32
             OR octet_length(d.identity_binding_signature) <> 64
             OR octet_length(d.fingerprint) <> 32))
ON CONFLICT (device_id) DO NOTHING;

UPDATE auth.devices d
   SET identity_signing_key = NULL,
       identity_dh_key = NULL,
       identity_binding_signature = NULL,
       fingerprint = NULL,
       identity_key_alg = 'LEGACY'
 WHERE (d.identity_key_alg = 'LEGACY'
        AND (d.identity_signing_key IS NOT NULL OR d.identity_dh_key IS NOT NULL
             OR d.identity_binding_signature IS NOT NULL OR d.fingerprint IS NOT NULL))
    OR (d.identity_key_alg = 'Ed25519+X25519'
        AND (d.identity_signing_key IS NULL OR d.identity_dh_key IS NULL
             OR d.identity_binding_signature IS NULL OR d.fingerprint IS NULL
             OR octet_length(d.identity_signing_key) <> 32
             OR octet_length(d.identity_dh_key) <> 32
             OR octet_length(d.identity_binding_signature) <> 64
             OR octet_length(d.fingerprint) <> 32));

-- 3b. Quarantine duplicate identity keys, keeping exactly one device per key.
--     Winner: a non-REVOKED device first (an active device must keep its keys), then the
--     oldest row. Applies to both unique keys (IK_sig and IK_dh).
WITH ranked_sig AS (
  SELECT d.id,
         row_number() OVER (PARTITION BY d.identity_signing_key
                            ORDER BY (d.status <> 'REVOKED') DESC, d.created_at, d.id) AS rn
    FROM auth.devices d
   WHERE d.identity_signing_key IS NOT NULL
), ranked_dh AS (
  SELECT d.id,
         row_number() OVER (PARTITION BY d.identity_dh_key
                            ORDER BY (d.status <> 'REVOKED') DESC, d.created_at, d.id) AS rn
    FROM auth.devices d
   WHERE d.identity_dh_key IS NOT NULL
), losers AS (
  SELECT id FROM ranked_sig WHERE rn > 1
  UNION
  SELECT id FROM ranked_dh WHERE rn > 1
)
INSERT INTO auth.identity_key_quarantine
       (device_id, user_id, identity_signing_key, identity_dh_key,
        identity_binding_signature, fingerprint, identity_key_alg, device_status, reason)
SELECT d.id, d.user_id, d.identity_signing_key, d.identity_dh_key,
       d.identity_binding_signature, d.fingerprint, d.identity_key_alg, d.status,
       'DUPLICATE_IDENTITY_KEY'
  FROM auth.devices d
  JOIN losers l ON l.id = d.id
ON CONFLICT (device_id) DO NOTHING;

WITH ranked_sig AS (
  SELECT d.id,
         row_number() OVER (PARTITION BY d.identity_signing_key
                            ORDER BY (d.status <> 'REVOKED') DESC, d.created_at, d.id) AS rn
    FROM auth.devices d
   WHERE d.identity_signing_key IS NOT NULL
), ranked_dh AS (
  SELECT d.id,
         row_number() OVER (PARTITION BY d.identity_dh_key
                            ORDER BY (d.status <> 'REVOKED') DESC, d.created_at, d.id) AS rn
    FROM auth.devices d
   WHERE d.identity_dh_key IS NOT NULL
), losers AS (
  SELECT id FROM ranked_sig WHERE rn > 1
  UNION
  SELECT id FROM ranked_dh WHERE rn > 1
)
UPDATE auth.devices d
   SET identity_signing_key = NULL,
       identity_dh_key = NULL,
       identity_binding_signature = NULL,
       fingerprint = NULL,
       identity_key_alg = 'LEGACY'
  FROM losers l
 WHERE d.id = l.id;

-- Fail fast if a duplicate survived the repair (no silent unique-index failure).
DO $$
DECLARE dup_sig integer;
DECLARE dup_dh  integer;
BEGIN
  SELECT count(*) INTO dup_sig FROM (
    SELECT identity_signing_key FROM auth.devices
     WHERE identity_signing_key IS NOT NULL
     GROUP BY identity_signing_key HAVING count(*) > 1) s;
  SELECT count(*) INTO dup_dh FROM (
    SELECT identity_dh_key FROM auth.devices
     WHERE identity_dh_key IS NOT NULL
     GROUP BY identity_dh_key HAVING count(*) > 1) d;
  IF dup_sig > 0 OR dup_dh > 0 THEN
    RAISE EXCEPTION 'IDENTITY_KEY_DUPLICATE_UNRESOLVED'
      USING ERRCODE = '23505',
            DETAIL = format('identity_signing_key groups=%s, identity_dh_key groups=%s', dup_sig, dup_dh),
            HINT = 'inspect auth.identity_key_quarantine; V17 refuses to drop key material of active devices silently';
  END IF;
END $$;

ALTER TABLE auth.devices FORCE ROW LEVEL SECURITY;

-- Hard/global uniqueness: a REVOKED row keeps its key bytes and still occupies the key.
DROP INDEX IF EXISTS auth.ux_devices_identity_sig;
DROP INDEX IF EXISTS auth.ux_devices_identity_dh;
CREATE UNIQUE INDEX ux_devices_identity_sig
  ON auth.devices (identity_signing_key)
  WHERE identity_signing_key IS NOT NULL;
CREATE UNIQUE INDEX ux_devices_identity_dh
  ON auth.devices (identity_dh_key)
  WHERE identity_dh_key IS NOT NULL;

-- NULL-safe all-or-none. Legacy: all four NULL + LEGACY. Keyed: all four NOT NULL with
-- exact lengths + Ed25519+X25519. `IS NOT NULL` comes before octet_length() so the
-- predicate can never evaluate to NULL.
ALTER TABLE auth.devices DROP CONSTRAINT IF EXISTS ck_devices_keys_all_or_none;
ALTER TABLE auth.devices
  ADD CONSTRAINT ck_devices_keys_all_or_none CHECK (
    (identity_key_alg = 'LEGACY'
     AND identity_signing_key IS NULL
     AND identity_dh_key IS NULL
     AND identity_binding_signature IS NULL
     AND fingerprint IS NULL)
    OR
    (identity_key_alg = 'Ed25519+X25519'
     AND identity_signing_key IS NOT NULL
     AND identity_dh_key IS NOT NULL
     AND identity_binding_signature IS NOT NULL
     AND fingerprint IS NOT NULL
     AND octet_length(identity_signing_key) = 32
     AND octet_length(identity_dh_key) = 32
     AND octet_length(identity_binding_signature) = 64
     AND octet_length(fingerprint) = 32)) NOT VALID;

ALTER TABLE auth.devices VALIDATE CONSTRAINT ck_devices_keys_all_or_none;

-- ============================================================================
-- 4. key_verifications scope trigger: target must be ACTIVE + capable, verifier device
--    must be ACTIVE (P2-03). Before this only chat membership was checked, so a REVOKED
--    target or a LEGACY verifier could be attested at the DB level.
-- ============================================================================
CREATE OR REPLACE FUNCTION auth.check_key_verification_scope()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  chat_ws      uuid;
  chat_deleted timestamptz;
  target_user  uuid;
  target_ok    boolean;
  verifier_ok  boolean;
BEGIN
  SELECT c.workspace_id, c.deleted_at INTO chat_ws, chat_deleted
    FROM chat.chats c WHERE c.id = NEW.chat_id;
  IF chat_ws IS NULL OR chat_ws <> NEW.workspace_id OR chat_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514',
            DETAIL = 'chat is missing, deleted, or belongs to another workspace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat.chat_members m
     WHERE m.chat_id = NEW.chat_id
       AND m.user_id = NEW.verifier_user_id
       AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'verifier is not an ACTIVE member of the chat';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.devices d
     WHERE d.id = NEW.verifier_device_id
       AND d.user_id = NEW.verifier_user_id
       AND d.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'verifier device is missing, REVOKED, or owned by another user';
  END IF;
  SELECT d.user_id,
         auth.device_is_e2ee_capable(d.status, d.identity_key_alg, d.identity_signing_key,
                                    d.identity_dh_key, d.identity_binding_signature,
                                    d.fingerprint)
    INTO target_user, target_ok
    FROM auth.devices d WHERE d.id = NEW.target_device_id;
  IF target_user IS NULL OR target_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'target is not an ACTIVE e2ee-capable device';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat.chat_members m
     WHERE m.chat_id = NEW.chat_id
       AND m.user_id = target_user
       AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'target is not an ACTIVE member of the chat';
  END IF;
  RETURN NEW;
END $$;

-- ============================================================================
-- 5. Indexes for the B2/B4 hot paths (EXPLAIN-asserted by E2eeMigrationIT):
--    claim already uses ix_prekeys_one_time_available; device lists use
--    ix_devices_user_status; identity lookups use the two unique indexes above.
--    Add the per-chat key-verification read path, which currently counts by
--    (verifier_device_id, chat_id) without a matching index.
-- ============================================================================
CREATE INDEX IF NOT EXISTS ix_key_verifications_verifier_chat
  ON auth.key_verifications (verifier_device_id, chat_id)
  WHERE revoked_at IS NULL;

-- ============================================================================
-- 6. Key-change fan-out scope (P1-03). SECURITY DEFINER because the caller may have no
--    workspace claim (revocation in prod) and must still notify every E2EE chat it is an
--    ACTIVE member of. It can only be asked about the current user, so krug_app cannot
--    enumerate another user's chats.
-- ============================================================================
CREATE OR REPLACE FUNCTION chat.e2ee_chat_scopes(p_user_id uuid)
  RETURNS TABLE (workspace_id uuid, chat_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.workspace_id, c.id
    FROM chat.chats c
    JOIN chat.chat_members m ON m.chat_id = c.id
   WHERE c.security_mode = 'E2EE'
     AND c.deleted_at IS NULL
     AND m.user_id = p_user_id
     AND m.status = 'ACTIVE'
     AND p_user_id = ops.current_user_id()
$$;

COMMENT ON FUNCTION chat.e2ee_chat_scopes(uuid)
  IS 'E7-B1F P1-03: E2EE chats of the current user for chat.keys.changed fan-out';

GRANT EXECUTE ON FUNCTION chat.e2ee_chat_scopes(uuid) TO krug_app;

-- ============================================================================
-- 7. Capability lookup for a workspace member (P2-10 / §6.2.8). A DIRECT chat does not
--    exist before creation, so p_devices_chat_peer cannot expose the future peer's
--    devices; the SECURITY DEFINER function answers only the boolean for an ACTIVE
--    workspace co-member (no key bytes, no device ids).
-- ============================================================================
CREATE OR REPLACE FUNCTION auth.user_has_e2ee_capable_device(p_workspace_id uuid,
                                                             p_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM workspace.memberships m
      JOIN auth.devices d ON d.user_id = m.user_id
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = p_user_id
       AND m.status = 'ACTIVE'
       AND auth.device_is_e2ee_capable(d.status, d.identity_key_alg, d.identity_signing_key,
                                       d.identity_dh_key, d.identity_binding_signature,
                                       d.fingerprint))
$$;

COMMENT ON FUNCTION auth.user_has_e2ee_capable_device(uuid, uuid)
  IS 'E7-B1F: E2EE DIRECT creation gate (§6.2.8 E2EE_NO_ACTIVE_DEVICES)';

GRANT EXECUTE ON FUNCTION auth.user_has_e2ee_capable_device(uuid, uuid) TO krug_app;
