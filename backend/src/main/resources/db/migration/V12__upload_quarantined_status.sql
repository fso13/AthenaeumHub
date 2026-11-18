-- E4-B follow-up: contract now exposes QUARANTINED in UploadSession.status (E4-AC-07).
-- INFECTED and scanner-FAILED uploads use this terminal state; the attachment keeps
-- scan_status=INFECTED/FAILED and download returns 423.

ALTER TABLE file.uploads DROP CONSTRAINT IF EXISTS uploads_status_check;
ALTER TABLE file.uploads DROP CONSTRAINT IF EXISTS ck_uploads_status;

ALTER TABLE file.uploads
  ADD CONSTRAINT ck_uploads_status
  CHECK (status IN ('INIT', 'UPLOADING', 'PAUSED', 'COMPLETING', 'SCANNING', 'READY',
                    'QUARANTINED', 'BOUND', 'FAILED', 'ABORTED', 'EXPIRED'));

COMMENT ON COLUMN file.uploads.status IS
  'UploadSession.status: QUARANTINED is the fail-closed AV outcome (download 423)';
