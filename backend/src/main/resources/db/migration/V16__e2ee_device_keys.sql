-- E7-B1 / I-01: device identity keys, prekeys, key verifications, E2EE envelopes,
-- DIRECT pair uniqueness and mode immutability. Forward-only, written against V1–V15.
--
-- Scope: storage + key lifecycle only. No E2EE message send/fan-out in this migration.
-- Rollout: `krug.e2ee.enabled=false` by default; the flag gates E2EE chat/creation/send,
-- not device key registration (keys are onboarding primitives).

-- ============================================================================
-- 1. auth.devices: two identity pairs, binding signature, fingerprint.
--    `identity_public_key` is dead in V1–V15 (never read by the backend); drop it.
-- ============================================================================
ALTER TABLE auth.devices
  ADD COLUMN identity_signing_key bytea,
  ADD COLUMN identity_dh_key bytea,
  ADD COLUMN identity_binding_signature bytea,
  ADD COLUMN fingerprint bytea;

ALTER TABLE auth.devices ALTER COLUMN identity_key_alg DROP DEFAULT;

-- P1-05 (migration role): `auth.devices` is FORCE RLS (V2). The table owner therefore
-- sees zero rows unless it is superuser/BYPASSRLS, and a managed PostgreSQL Flyway role is
-- usually a non-superuser owner. Without this block the two backfills below would silently
-- update nothing (and only a later constraint would fail, with an unrelated message).
-- FORCE is restored immediately after the backfill; ENABLE stays on for the whole
-- migration, so `krug_app` keeps the tenant policy. Flyway runs this file in one
-- transaction, so a failure rolls the NO FORCE change back as well.
ALTER TABLE auth.devices NO FORCE ROW LEVEL SECURITY;

UPDATE auth.devices
   SET identity_key_alg = 'LEGACY'
 WHERE identity_signing_key IS NULL;
UPDATE auth.devices
   SET identity_key_alg = 'Ed25519+X25519'
 WHERE identity_signing_key IS NOT NULL;

-- Fail fast if the backfill did not reach the real rows (for example because a future
-- edit re-introduced a role/RLS mismatch). No silent no-op.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM auth.devices
   WHERE (identity_signing_key IS NULL AND identity_key_alg <> 'LEGACY')
      OR (identity_signing_key IS NOT NULL AND identity_key_alg <> 'Ed25519+X25519');
  IF bad > 0 THEN
    RAISE EXCEPTION 'DEVICE_KEY_BACKFILL_INCOMPLETE'
      USING ERRCODE = '23514',
            DETAIL = bad || ' auth.devices rows keep a pre-E7 identity_key_alg',
            HINT = 'run V16 as the schema owner (FORCE RLS is temporarily disabled for the backfill) or grant BYPASSRLS';
  END IF;
END $$;

ALTER TABLE auth.devices FORCE ROW LEVEL SECURITY;

ALTER TABLE auth.devices
  ADD CONSTRAINT ck_devices_identity_key_alg
    CHECK (identity_key_alg IN ('LEGACY', 'Ed25519+X25519')),
  ADD CONSTRAINT ck_devices_keys_all_or_none CHECK (
    (identity_signing_key IS NULL AND identity_dh_key IS NULL
     AND identity_binding_signature IS NULL AND fingerprint IS NULL
     AND identity_key_alg = 'LEGACY')
    OR
    (octet_length(identity_signing_key) = 32
     AND octet_length(identity_dh_key) = 32
     AND octet_length(identity_binding_signature) = 64
     AND octet_length(fingerprint) = 32
     AND identity_key_alg = 'Ed25519+X25519'));

-- Public keys may not be copied into another account. These indexes are PARTIAL by
-- status: they only block a second non-REVOKED copy. A REVOKED identity pair can
-- therefore be re-registered by another account here — V17 removes the partial predicate
-- and makes uniqueness hard/global (E2EE-REVIEW-04 P1-06). Keep V16's predicate only so
-- V1..V16 stay executable on historical duplicates; V17 is the enforced invariant.
CREATE UNIQUE INDEX ux_devices_identity_sig
  ON auth.devices (identity_signing_key)
  WHERE status <> 'REVOKED' AND identity_signing_key IS NOT NULL;
CREATE UNIQUE INDEX ux_devices_identity_dh
  ON auth.devices (identity_dh_key)
  WHERE status <> 'REVOKED' AND identity_dh_key IS NOT NULL;

ALTER TABLE auth.devices DROP COLUMN identity_public_key;

-- Peer visibility: p_devices_self (V2) exposes only the caller's devices, but claim,
-- chat keys and E2EE send must read the peer's ACTIVE devices. A separate additive
-- SELECT policy scoped to a common chat in the current workspace keeps self intact.
CREATE POLICY p_devices_chat_peer ON auth.devices
  FOR SELECT
  USING (
    status = 'ACTIVE'
    AND EXISTS (
      SELECT 1
      FROM chat.chat_members me
      JOIN chat.chat_members peer
        ON peer.chat_id = me.chat_id AND peer.status = 'ACTIVE'
      JOIN chat.chats c
        ON c.id = me.chat_id AND c.deleted_at IS NULL
       AND c.workspace_id = ops.current_workspace_id()
      WHERE me.user_id = ops.current_user_id()
        AND me.status = 'ACTIVE'
        AND peer.user_id = auth.devices.user_id
    )
  );

-- ============================================================================
-- 2. auth.device_prekeys: signed and one-time prekeys, TTL, retire, consume.
-- ============================================================================
CREATE TABLE auth.device_prekeys (
  device_id      uuid NOT NULL REFERENCES auth.devices(id) ON DELETE CASCADE,
  key_id         text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  kind           text NOT NULL CHECK (kind IN ('SIGNED', 'ONE_TIME')),
  public_key     bytea NOT NULL CHECK (octet_length(public_key) = 32),
  signature      bytea,
  signature_alg  text NOT NULL DEFAULT 'Ed25519',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  retired_at     timestamptz,
  consumed_at    timestamptz,
  PRIMARY KEY (device_id, key_id),
  CHECK (kind <> 'SIGNED' OR (signature IS NOT NULL AND octet_length(signature) = 64)),
  CHECK (kind <> 'ONE_TIME' OR signature IS NULL)
);

CREATE UNIQUE INDEX ux_prekeys_one_signed_active
  ON auth.device_prekeys (device_id) WHERE kind = 'SIGNED' AND retired_at IS NULL;
CREATE INDEX ix_prekeys_one_time_available
  ON auth.device_prekeys (device_id, expires_at)
  WHERE kind = 'ONE_TIME' AND consumed_at IS NULL;

-- RLS: owner full access; chat peers read public keys. FORCE is deliberately omitted:
-- the SECURITY DEFINER claim function (owned by the migration role) must update
-- consumed_at, while krug_app remains subject to the policies below.
ALTER TABLE auth.device_prekeys ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_prekeys_owner ON auth.device_prekeys
  USING (EXISTS (
    SELECT 1 FROM auth.devices d
     WHERE d.id = device_id AND d.user_id = ops.current_user_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM auth.devices d
     WHERE d.id = device_id AND d.user_id = ops.current_user_id()));

CREATE POLICY p_prekeys_chat_peer_read ON auth.device_prekeys
  FOR SELECT
  USING (EXISTS (
    SELECT 1
      FROM auth.devices d
      JOIN chat.chat_members me
        ON me.user_id = ops.current_user_id() AND me.status = 'ACTIVE'
      JOIN chat.chat_members peer
        ON peer.chat_id = me.chat_id AND peer.status = 'ACTIVE'
      JOIN chat.chats c
        ON c.id = me.chat_id AND c.deleted_at IS NULL
       AND c.workspace_id = ops.current_workspace_id()
     WHERE d.id = auth.device_prekeys.device_id
       AND d.status = 'ACTIVE'
       AND peer.user_id = d.user_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.device_prekeys TO krug_app;

-- Atomic one-time prekey claim. Membership is checked in the CURRENT workspace
-- (chat_members.chat_id alone does not prove tenant). A missing OPK is not an error:
-- the caller falls back to 3DH with otp_exhausted=true.
CREATE OR REPLACE FUNCTION auth.claim_one_time_prekey(p_device_id uuid, p_chat_id uuid)
  RETURNS auth.device_prekeys
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k auth.device_prekeys;
  target_user uuid;
BEGIN
  SELECT d.user_id INTO target_user
    FROM auth.devices d
   WHERE d.id = p_device_id AND d.status = 'ACTIVE';
  IF target_user IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_DEVICE' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM chat.chat_members me
      JOIN chat.chat_members peer
        ON peer.chat_id = me.chat_id AND peer.status = 'ACTIVE'
      JOIN chat.chats c
        ON c.id = me.chat_id
       AND c.deleted_at IS NULL
       AND c.workspace_id = ops.current_workspace_id()
     WHERE me.chat_id = p_chat_id
       AND me.user_id = ops.current_user_id()
       AND me.status = 'ACTIVE'
       AND peer.user_id = target_user
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_DEVICE' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO k
    FROM auth.device_prekeys
   WHERE device_id = p_device_id
     AND kind = 'ONE_TIME'
     AND consumed_at IS NULL
     AND expires_at > now()
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE auth.device_prekeys
     SET consumed_at = now()
   WHERE device_id = k.device_id AND key_id = k.key_id;
  RETURN k;
END $$;

GRANT EXECUTE ON FUNCTION auth.claim_one_time_prekey(uuid, uuid) TO krug_app;

-- ============================================================================
-- 3. message.messages: E2EE invariants (crypto_scheme is the message source of truth).
-- ============================================================================
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_e2ee_no_managed_body
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR body_ciphertext IS NULL),
  ADD CONSTRAINT ck_messages_e2ee_no_sticker
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR sticker_id IS NULL),
  ADD CONSTRAINT ck_messages_e2ee_meta
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR content_meta = '{}'::jsonb),
  ADD CONSTRAINT ck_messages_e2ee_type
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR type = 'TEXT'),
  ADD CONSTRAINT ck_messages_e2ee_no_reply_to_id
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR reply_to_id IS NULL),
  ADD CONSTRAINT ck_messages_e2ee_sender_required
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE'
           OR (sender_id IS NOT NULL AND sender_device_id IS NOT NULL));

-- ============================================================================
-- 4. auth.key_verifications: verified is scoped to the verifier DEVICE.
-- ============================================================================
CREATE TABLE auth.key_verifications (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id               uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  verifier_user_id      uuid NOT NULL,
  verifier_device_id    uuid NOT NULL,
  target_device_id      uuid NOT NULL REFERENCES auth.devices(id) ON DELETE CASCADE,
  target_key_generation integer NOT NULL CHECK (target_key_generation > 0),
  method                text NOT NULL CHECK (method IN ('QR', 'MANUAL')),
  vh_version            integer NOT NULL CHECK (vh_version = 2),
  safety_number_hash    bytea NOT NULL CHECK (octet_length(safety_number_hash) = 32),
  verified_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  UNIQUE (verifier_device_id, target_device_id, chat_id),
  CONSTRAINT fk_key_verifications_verifier_owner
    FOREIGN KEY (verifier_user_id, verifier_device_id)
    REFERENCES auth.devices (user_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_key_verifications_chat ON auth.key_verifications (chat_id);
CREATE INDEX ix_key_verifications_target
  ON auth.key_verifications (target_device_id, revoked_at);

ALTER TABLE auth.key_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.key_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY p_key_verifications_tenant ON auth.key_verifications
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

-- Strict scope is checked on INSERT only. A WITH CHECK by membership would be
-- re-evaluated on UPDATE and would block revoke/soft-delete bookkeeping.
CREATE OR REPLACE FUNCTION auth.check_key_verification_scope()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  chat_ws      uuid;
  chat_deleted timestamptz;
  target_user  uuid;
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
  SELECT d.user_id INTO target_user FROM auth.devices d WHERE d.id = NEW.target_device_id;
  IF target_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM chat.chat_members m
     WHERE m.chat_id = NEW.chat_id
       AND m.user_id = target_user
       AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'target is not an ACTIVE member of the chat';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_key_verifications_scope
  BEFORE INSERT ON auth.key_verifications
  FOR EACH ROW EXECUTE FUNCTION auth.check_key_verification_scope();

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.key_verifications TO krug_app;

-- ============================================================================
-- 5. chat.chats.direct_key: ordered UUID pair, unique among live DIRECT chats.
-- ============================================================================
ALTER TABLE chat.chats ADD COLUMN direct_key text;

-- Every DIRECT chat must have exactly two distinct member rows, regardless of status.
-- A REMOVED participant is still part of the pair; data corruption fails fast.
--
-- P1-05: the preflight/backfill read chat.chats and chat.chat_members, both FORCE RLS. A
-- non-superuser migration owner would see zero rows (backfill no-op) and then the
-- leftover check below would fail for every DIRECT chat. Disable FORCE for the duration
-- of the repair only; both tables are FORCE again before the next section. ENABLE stays
-- on, so `krug_app` keeps the tenant policy.
ALTER TABLE chat.chats NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_members NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE bad_direct text;
BEGIN
  SELECT string_agg(c.id::text, ',' ORDER BY c.id) INTO bad_direct
    FROM chat.chats c
   WHERE c.type = 'DIRECT'
     AND (SELECT count(DISTINCT m.user_id)
            FROM chat.chat_members m
           WHERE m.chat_id = c.id) <> 2;
  IF bad_direct IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_KEY_UNRESOLVED'
      USING ERRCODE = '23514',
            DETAIL = 'DIRECT chats without exactly 2 distinct member rows: ' || bad_direct,
            HINT = 'repair chat_members or soft-delete the chat; see E2EE-SPEC §6.5.2';
  END IF;
END $$;

WITH pairs AS (
  SELECT c.id,
         min(m.user_id::text) || ':' || max(m.user_id::text) AS dk
    FROM chat.chats c
    JOIN chat.chat_members m ON m.chat_id = c.id
   WHERE c.type = 'DIRECT'
   GROUP BY c.id
  HAVING count(DISTINCT m.user_id) = 2
)
UPDATE chat.chats c SET direct_key = p.dk FROM pairs p WHERE c.id = p.id;

DO $$
DECLARE leftover text;
BEGIN
  SELECT string_agg(id::text, ',' ORDER BY id) INTO leftover
    FROM chat.chats WHERE type = 'DIRECT' AND direct_key IS NULL;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_KEY_UNRESOLVED'
      USING ERRCODE = '23514',
            DETAIL = 'DIRECT chats with direct_key still NULL after backfill: ' || leftover,
            HINT = 'see E2EE-SPEC §6.5.2';
  END IF;
END $$;

DO $$
DECLARE dup_pairs text;
BEGIN
  SELECT string_agg(p.pair, ',' ORDER BY p.pair) INTO dup_pairs
    FROM (
      SELECT c.workspace_id::text || '/' || c.direct_key AS pair
        FROM chat.chats c
       WHERE c.type = 'DIRECT' AND c.deleted_at IS NULL
       GROUP BY c.workspace_id, c.direct_key
      HAVING count(*) > 1
    ) p;
  IF dup_pairs IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_PAIR_DUPLICATE'
      USING ERRCODE = '23505',
            DETAIL = 'more than one live DIRECT chat for pair(s): ' || dup_pairs,
            HINT = 'soft-delete the newer duplicate, then re-run V16 (E2EE-SPEC §6.5.2)';
  END IF;
END $$;

ALTER TABLE chat.chats FORCE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_members FORCE ROW LEVEL SECURITY;

ALTER TABLE chat.chats
  ADD CONSTRAINT ck_chats_direct_key CHECK (
    (type = 'DIRECT' AND direct_key IS NOT NULL)
    OR (type <> 'DIRECT' AND direct_key IS NULL)) NOT VALID,
  ADD CONSTRAINT ck_chats_direct_key_format CHECK (
    type <> 'DIRECT'
    OR (direct_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND split_part(direct_key, ':', 1) < split_part(direct_key, ':', 2))) NOT VALID;

ALTER TABLE chat.chats VALIDATE CONSTRAINT ck_chats_direct_key;
ALTER TABLE chat.chats VALIDATE CONSTRAINT ck_chats_direct_key_format;

CREATE UNIQUE INDEX ux_chats_direct_pair
  ON chat.chats (workspace_id, direct_key)
  WHERE type = 'DIRECT' AND deleted_at IS NULL;

-- ============================================================================
-- 6. security_mode is immutable for chats and workspaces.
-- ============================================================================
CREATE OR REPLACE FUNCTION ops.forbid_security_mode_change()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.security_mode IS DISTINCT FROM OLD.security_mode THEN
    RAISE EXCEPTION 'MODE_CHANGE_FORBIDDEN'
      USING ERRCODE = '23514', DETAIL = 'security_mode is immutable; create a new chat/workspace';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_chats_security_mode_immutable
  BEFORE UPDATE ON chat.chats
  FOR EACH ROW EXECUTE FUNCTION ops.forbid_security_mode_change();
CREATE TRIGGER trg_workspaces_security_mode_immutable
  BEFORE UPDATE ON workspace.workspaces
  FOR EACH ROW EXECUTE FUNCTION ops.forbid_security_mode_change();

-- ============================================================================
-- 7. message.message_envelopes: opaque per-recipient-device envelopes.
-- ============================================================================
CREATE TABLE message.message_envelopes (
  message_id               uuid NOT NULL,
  recipient_device_id      uuid NOT NULL,
  sender_device_id         uuid NOT NULL,
  workspace_id             uuid NOT NULL,
  chat_id                  uuid NOT NULL,
  scheme                   text NOT NULL CHECK (scheme = 'PAIRWISE_X3DH_DR'),
  sender_key_generation    integer NOT NULL CHECK (sender_key_generation > 0),
  recipient_key_generation integer NOT NULL CHECK (recipient_key_generation > 0),
  session_id               bytea NOT NULL CHECK (octet_length(session_id) = 16),
  header                   jsonb NOT NULL CHECK (jsonb_typeof(header) = 'object'),
  -- Canonical v1 acceptance cap: decoded 16..33040 B (33024 padded + 16 tag).
  ciphertext               bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 33040),
  prekey                   jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_device_id, created_at),
  CHECK (prekey IS NULL OR jsonb_typeof(prekey) = 'object')
) PARTITION BY RANGE (created_at);

-- Parent indexes are inherited by every current and future partition (exactly 4 indexes
-- per envelope partition including the PK). Do not duplicate them in ensure_partition().
CREATE INDEX ix_envelopes_recipient
  ON message.message_envelopes (recipient_device_id, created_at);
CREATE INDEX ix_envelopes_message
  ON message.message_envelopes (message_id, created_at);
CREATE INDEX ix_envelopes_ws_chat
  ON message.message_envelopes (workspace_id, chat_id, created_at);

ALTER TABLE message.message_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE message.message_envelopes FORCE ROW LEVEL SECURITY;
CREATE POLICY p_message_envelopes_tenant ON message.message_envelopes
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON message.message_envelopes TO krug_app;

-- ============================================================================
-- 8. ensure_partition(): both messages and envelopes, sender-scoped client ids.
-- ============================================================================
CREATE OR REPLACE FUNCTION message.ensure_partition(p_month date)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (start_date + interval '1 month')::date;
  part_name  text := format('messages_%s', to_char(start_date, 'YYYY_MM'));
  env_name   text := format('message_envelopes_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS message.%I PARTITION OF message.messages FOR VALUES FROM (%L) TO (%L)',
    part_name, start_date, end_date);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I (chat_id, seq)',
    'ux_' || part_name || '_chat_seq', part_name);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I (chat_id, sender_id, client_message_id) '
                 'WHERE client_message_id IS NOT NULL',
    'ux_' || part_name || '_chat_sender_client', part_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON message.%I (chat_id, created_at DESC)',
    'ix_' || part_name || '_chat_created', part_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON message.%I (workspace_id, chat_id, seq)',
    'ix_' || part_name || '_ws_chat_seq', part_name);
  EXECUTE format('ALTER TABLE message.%I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE message.%I FORCE ROW LEVEL SECURITY', part_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON message.%I', 'p_' || part_name || '_tenant', part_name);
  EXECUTE format('CREATE POLICY %I ON message.%I USING (workspace_id = ops.current_workspace_id()) '
                 'WITH CHECK (workspace_id = ops.current_workspace_id())',
    'p_' || part_name || '_tenant', part_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON message.%I TO krug_app', part_name);

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS message.%I PARTITION OF message.message_envelopes '
    'FOR VALUES FROM (%L) TO (%L)',
    env_name, start_date, end_date);
  EXECUTE format('ALTER TABLE message.%I ENABLE ROW LEVEL SECURITY', env_name);
  EXECUTE format('ALTER TABLE message.%I FORCE ROW LEVEL SECURITY', env_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON message.%I', 'p_' || env_name || '_tenant', env_name);
  EXECUTE format('CREATE POLICY %I ON message.%I USING (workspace_id = ops.current_workspace_id()) '
                 'WITH CHECK (workspace_id = ops.current_workspace_id())',
    'p_' || env_name || '_tenant', env_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON message.%I TO krug_app', env_name);
END $$;

-- Existing partitions: replace the old (chat_id, client_message_id) unique index with
-- the sender-scoped one. Replay must filter sender_id = caller.
DO $$
DECLARE part record;
BEGIN
  FOR part IN
    SELECT c.relname AS name
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'message.messages'::regclass
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS message.%I', 'ux_' || part.name || '_client');
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I '
                   '(chat_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL',
                   'ux_' || part.name || '_chat_sender_client', part.name);
  END LOOP;
END $$;

-- Current + two future months, both tables. The first envelope INSERT cannot fail
-- with "no partition of relation found".
SELECT message.ensure_partition(date_trunc('month', now())::date);
SELECT message.ensure_partition((date_trunc('month', now()) + interval '1 month')::date);
SELECT message.ensure_partition((date_trunc('month', now()) + interval '2 months')::date);
