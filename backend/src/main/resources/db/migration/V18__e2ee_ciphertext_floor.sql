-- E7-B3F / E2EE-REVIEW-06 P1-02: align the persisted ciphertext floor with the wire
-- contract (`CryptoEnvelope.ciphertext.minLength: 363` = 272 decoded bytes).
--
-- v1 canonical padding is one 256-byte block + the 16-byte AEAD tag. The server used to
-- accept 16 bytes and could then return an envelope that violates its own OpenAPI schema
-- (`minLength: 363`), which lets a sender make a conforming client reject a whole page.
-- The codec already rejects shorter values; this CHECK is the storage-level backstop.
--
-- NOT VALID on purpose: rows written before this migration stay readable for audit and
-- the rollout does not fail on legacy short envelopes. Every new INSERT/UPDATE is checked
-- by PostgreSQL from the moment the constraint exists, including all partitions.
ALTER TABLE message.message_envelopes
  DROP CONSTRAINT IF EXISTS ck_envelopes_ciphertext_min;

ALTER TABLE message.message_envelopes
  ADD CONSTRAINT ck_envelopes_ciphertext_min
  CHECK (octet_length(ciphertext) BETWEEN 272 AND 33040) NOT VALID;

COMMENT ON CONSTRAINT ck_envelopes_ciphertext_min ON message.message_envelopes
  IS 'E7-B3F P1-02: canonical v1 ciphertext is 272..33040 decoded bytes (363..44054 b64u chars)';
