-- E4-B: a managed TEXT message may consist only of attachments (text is nullable in
-- contracts/openapi.yaml Message/MessageCreate). V4 had a check requiring ciphertext for
-- every TEXT row. Drop those unnamed V4 checks and keep the SYSTEM invariant.
--
-- Safe/forward-only: existing rows all satisfy the new (weaker) invariant.

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS messages_check;
ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS messages_check1;

ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_system_no_body
  CHECK (type <> 'SYSTEM' OR body_ciphertext IS NULL);

COMMENT ON COLUMN message.messages.body_ciphertext IS
  'Managed AES-GCM ciphertext; NULL when a TEXT message carries attachments only';
