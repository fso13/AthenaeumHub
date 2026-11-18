-- E7-B3F3 / E2EE-REVIEW-08 P2-11: quarantine access control and retention.
--
-- V19 made `message.message_envelopes_quarantine` owner-only by simply not granting it to
-- `krug_app`. That is not defence in depth: if the deployment ever runs the application as
-- the schema owner (`DB_USER == FLYWAY_USER`) or a future migration adds a broad
-- `GRANT ... ON ALL TABLES IN SCHEMA message`, the table becomes readable by the runtime.
--
-- This migration:
--   1. enables RLS with NO policy. The owner still bypasses RLS (FORCE is intentionally
--      left off) and can therefore run retention; every non-owner is denied even if a
--      future GRANT is added;
--   2. keeps the table owner-only by revoking any runtime/PUBLIC privileges explicitly;
--   3. adds a bounded, owner-owned SECURITY DEFINER retention function. `krug_app` may
--      only execute it (it can never read/write the table directly), and the retention
--      window is validated inside the function so a caller cannot purge recent evidence;
--   4. indexes `quarantined_at` for the retention scan.
--
-- The Java scheduler `EnvelopeQuarantineRetentionScheduler` calls the function when
-- `krug.e2ee.quarantine-retention-enabled=true`; the default window is 90 days. An operator
-- without the application can run `SELECT message.purge_envelope_quarantine(90);`.
ALTER TABLE message.message_envelopes_quarantine ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE message.message_envelopes_quarantine FROM PUBLIC;
REVOKE ALL ON TABLE message.message_envelopes_quarantine FROM krug_app;

CREATE INDEX IF NOT EXISTS ix_envelope_quarantine_quarantined_at
  ON message.message_envelopes_quarantine (quarantined_at);

CREATE OR REPLACE FUNCTION message.purge_envelope_quarantine(p_retention_days integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, message
AS $$
DECLARE
  deleted integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'QUARANTINE_RETENTION_INVALID'
      USING ERRCODE = '22023',
            DETAIL = 'retention days must be within 1..3650';
  END IF;

  DELETE FROM message.message_envelopes_quarantine
   WHERE quarantined_at < now() - make_interval(days => p_retention_days);

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $$;

COMMENT ON FUNCTION message.purge_envelope_quarantine(integer)
  IS 'E7-B3F3 P2-11: bounded retention for message.message_envelopes_quarantine. Runs as the schema owner so the runtime role needs no table privilege.';

REVOKE ALL ON FUNCTION message.purge_envelope_quarantine(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message.purge_envelope_quarantine(integer) TO krug_app;
