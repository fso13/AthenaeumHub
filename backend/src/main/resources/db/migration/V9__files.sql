-- E4-B managed files: limits/quota, upload sessions, parts, attachments, reservations.
--
-- Tenant model:
--   * every table carries workspace_id and is protected by FORCE RLS;
--   * normal transactions use ops.current_workspace_id();
--   * background jobs use the explicit transaction-local worker role:
--       app.worker_role = 'file-scan'      -> malware scanner across tenants
--       app.worker_role = 'file-gc'        -> expired uploads/attachments
--       app.worker_role = 'file-reconcile' -> daily storage usage reconciliation
-- The worker role is a narrow, auditable privilege (same pattern as V8).
--
-- Quota model (SYSTEM-ANALYSIS §6.7):
--   workspace_usage.used_bytes     - committed attachments (complete)
--   workspace_usage.reserved_bytes - active reservations (init..complete/abort)
--   Invariant: used + reserved + new <= workspace_limits.storage_bytes.
--   A reservation is ACTIVE -> COMMITTED (complete) or RELEASED/EXPIRED.

CREATE SCHEMA IF NOT EXISTS file;
GRANT USAGE ON SCHEMA file TO krug_app;

CREATE TABLE file.workspace_limits (
  workspace_id      uuid PRIMARY KEY,
  tariff            text NOT NULL DEFAULT 'TEAM'
                    CHECK (tariff IN ('COMMUNITY', 'FAMILY', 'TEAM', 'ENTERPRISE')),
  max_file_bytes    bigint NOT NULL DEFAULT 2147483648 CHECK (max_file_bytes > 0),
  storage_bytes     bigint NOT NULL DEFAULT 1099511627776 CHECK (storage_bytes > 0),
  max_attachments   integer NOT NULL DEFAULT 10 CHECK (max_attachments BETWEEN 1 AND 10),
  guest_file_bytes  bigint NOT NULL DEFAULT 524288000 CHECK (guest_file_bytes > 0),
  retention_months  integer NOT NULL DEFAULT 12 CHECK (retention_months BETWEEN 1 AND 120),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE file.workspace_usage (
  workspace_id    uuid PRIMARY KEY,
  used_bytes      bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes  bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE file.uploads (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id           uuid NOT NULL,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename          text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type         text,
  size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
  sha256            text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  encryption_mode   text NOT NULL DEFAULT 'MANAGED' CHECK (encryption_mode = 'MANAGED'),
  status            text NOT NULL DEFAULT 'INIT'
                    CHECK (status IN ('INIT', 'UPLOADING', 'PAUSED', 'COMPLETING',
                                      'SCANNING', 'READY', 'BOUND', 'FAILED', 'ABORTED',
                                      'EXPIRED')),
  part_size         integer NOT NULL CHECK (part_size > 0),
  total_parts       integer NOT NULL CHECK (total_parts BETWEEN 1 AND 10000),
  object_key        text UNIQUE,
  storage_upload_id text,
  attachment_id     uuid,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE INDEX ix_uploads_workspace_status ON file.uploads (workspace_id, status);
CREATE INDEX ix_uploads_chat_created ON file.uploads (chat_id, created_at DESC);
CREATE INDEX ix_uploads_expires ON file.uploads (expires_at)
  WHERE status IN ('INIT', 'UPLOADING', 'PAUSED', 'SCANNING', 'READY');
CREATE INDEX ix_uploads_attachment ON file.uploads (attachment_id)
  WHERE attachment_id IS NOT NULL;

CREATE TABLE file.upload_parts (
  upload_id    uuid NOT NULL REFERENCES file.uploads(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  part_no      integer NOT NULL CHECK (part_no BETWEEN 1 AND 10000),
  sha256       text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  etag         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, part_no)
);

CREATE INDEX ix_upload_parts_workspace ON file.upload_parts (workspace_id);

CREATE TABLE file.attachments (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id       uuid NOT NULL,
  upload_id     uuid NOT NULL UNIQUE REFERENCES file.uploads(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id    uuid,
  filename      text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type     text,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_key    text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'READY'
                CHECK (status IN ('READY', 'BOUND', 'QUARANTINED', 'DELETED', 'FAILED')),
  scan_status   text NOT NULL DEFAULT 'PENDING'
                CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE INDEX ix_attachments_workspace_status ON file.attachments (workspace_id, status);
CREATE INDEX ix_attachments_workspace_scan ON file.attachments (workspace_id, scan_status);
CREATE INDEX ix_attachments_message ON file.attachments (message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX ix_attachments_chat_created ON file.attachments (chat_id, created_at DESC);
CREATE INDEX ix_attachments_unbound ON file.attachments (created_at)
  WHERE status = 'READY' AND message_id IS NULL;

CREATE TABLE file.quota_reservations (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  upload_id     uuid NOT NULL UNIQUE REFERENCES file.uploads(id) ON DELETE CASCADE,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE INDEX ix_quota_reservations_workspace_status
  ON file.quota_reservations (workspace_id, status);
CREATE INDEX ix_quota_reservations_expires
  ON file.quota_reservations (expires_at)
  WHERE status = 'ACTIVE';

-- Backfill before RLS is enabled: existing workspaces get the safe Team defaults
-- (2 GiB per file, 1 TiB storage, 10 attachments, 500 MiB guest file).
INSERT INTO file.workspace_limits (workspace_id)
SELECT id FROM workspace.workspaces
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO file.workspace_usage (workspace_id)
SELECT id FROM workspace.workspaces
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE file.workspace_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE file.workspace_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY p_workspace_limits_tenant ON file.workspace_limits
  USING (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  )
  WITH CHECK (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  );

ALTER TABLE file.workspace_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE file.workspace_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY p_workspace_usage_tenant ON file.workspace_usage
  USING (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  )
  WITH CHECK (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  );

ALTER TABLE file.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE file.uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY p_uploads_tenant ON file.uploads
  USING (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  )
  WITH CHECK (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  );

ALTER TABLE file.upload_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE file.upload_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY p_upload_parts_tenant ON file.upload_parts
  USING (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  )
  WITH CHECK (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  );

ALTER TABLE file.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE file.attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY p_attachments_tenant ON file.attachments
  USING (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  )
  WITH CHECK (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  );

ALTER TABLE file.quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE file.quota_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY p_quota_reservations_tenant ON file.quota_reservations
  USING (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  )
  WITH CHECK (
    workspace_id = ops.current_workspace_id()
    OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile')
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON file.workspace_limits, file.workspace_usage, file.uploads, file.upload_parts,
     file.attachments, file.quota_reservations
  TO krug_app;

COMMENT ON TABLE file.uploads IS
  'E4-B managed upload sessions (E2EE files intentionally absent from this slice)';
COMMENT ON TABLE file.attachments IS
  'E4-B managed attachments; AV status is fail-closed (PENDING/INFECTED/FAILED never downloadable)';
COMMENT ON TABLE file.quota_reservations IS
  'E4-B quota reservations: ACTIVE->COMMITTED on complete, RELEASED/EXPIRED otherwise';
