-- E7-B3F2 / E2EE-REVIEW-07 P1-03: retire legacy envelopes that the V18 floor cannot
-- validate.
--
-- V18 added `ck_envelopes_ciphertext_min` as NOT VALID on purpose, so an upgraded database
-- may still contain envelopes written before the canonical 272-byte floor (16..271 bytes).
-- Those rows are schema-invalid: the strict read path used to construct `CryptoEnvelope`
-- from them and answered 500 for the whole page (GET history and WS replay). The read path
-- is now tolerant (`crypto:null`, no 500), but the storage invariant must also become true
-- so `VALIDATE CONSTRAINT` is more than a promise.
--
-- This migration is lossless: every invalid row is copied verbatim to
-- `message.message_envelopes_quarantine` (reason `legacy_short` / `legacy_out_of_range`)
-- before it is removed from the live table. Valid rows are never touched. The quarantine
-- table is owner-only (no GRANT to `krug_app`, same pattern as V17's identity quarantine),
-- so runtime code cannot read or write it.
--
-- The migration role is the schema owner and `message_envelopes` is FORCE RLS. Disable
-- FORCE for the owner for the duration of the copy/delete (the V16/V17 pattern); ENABLE
-- stays on, so `krug_app` keeps the tenant policy. Flyway runs this file in one
-- transaction, so a failure restores the previous state as well.
ALTER TABLE message.message_envelopes NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS message.message_envelopes_quarantine (
  message_id               uuid NOT NULL,
  recipient_device_id      uuid NOT NULL,
  sender_device_id         uuid NOT NULL,
  workspace_id             uuid NOT NULL,
  chat_id                  uuid NOT NULL,
  scheme                   text NOT NULL,
  sender_key_generation    integer NOT NULL,
  recipient_key_generation integer NOT NULL,
  session_id               bytea NOT NULL,
  header                   jsonb NOT NULL,
  ciphertext               bytea NOT NULL,
  prekey                   jsonb,
  created_at               timestamptz NOT NULL,
  reason                   text NOT NULL,
  quarantined_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_device_id, created_at)
);

COMMENT ON TABLE message.message_envelopes_quarantine
  IS 'V19 (P1-03): legacy/invalid message envelopes removed from message.message_envelopes so the V18 ciphertext floor can be validated; kept verbatim for audit/forensics.';

INSERT INTO message.message_envelopes_quarantine
       (message_id, recipient_device_id, sender_device_id, workspace_id, chat_id, scheme,
        sender_key_generation, recipient_key_generation, session_id, header, ciphertext,
        prekey, created_at, reason)
SELECT message_id, recipient_device_id, sender_device_id, workspace_id, chat_id, scheme,
       sender_key_generation, recipient_key_generation, session_id, header, ciphertext,
       prekey, created_at,
       CASE WHEN octet_length(ciphertext) < 272 THEN 'legacy_short'
            ELSE 'legacy_out_of_range' END
  FROM message.message_envelopes
 WHERE octet_length(ciphertext) < 272
    OR octet_length(ciphertext) > 33040
ON CONFLICT (message_id, recipient_device_id, created_at) DO NOTHING;

-- P2-11 (E7-B3F3): delete only rows that are actually present in the quarantine with the
-- same identity and bytes. If a conflicting quarantine row already existed (same primary
-- key, different ciphertext/session/header), the INSERT above skipped it, the DELETE below
-- leaves the live row in place, and VALIDATE fails fast instead of silently losing it.
DELETE FROM message.message_envelopes e
 WHERE (octet_length(e.ciphertext) < 272 OR octet_length(e.ciphertext) > 33040)
   AND EXISTS (
         SELECT 1
           FROM message.message_envelopes_quarantine q
          WHERE q.message_id = e.message_id
            AND q.recipient_device_id = e.recipient_device_id
            AND q.created_at = e.created_at
            AND q.workspace_id = e.workspace_id
            AND q.chat_id = e.chat_id
            AND q.session_id = e.session_id
            AND q.header = e.header
            AND q.ciphertext = e.ciphertext);

-- Validates while the owner can still see every row (FORCE RLS is restored afterwards).
-- PostgreSQL 16 recurses into every current partition of the partitioned table.
ALTER TABLE message.message_envelopes
  VALIDATE CONSTRAINT ck_envelopes_ciphertext_min;

ALTER TABLE message.message_envelopes FORCE ROW LEVEL SECURITY;
