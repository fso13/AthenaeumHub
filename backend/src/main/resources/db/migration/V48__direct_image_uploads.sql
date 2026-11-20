-- #92: trusted direct-image uploads for avatars, channel covers/avatars and workspace logos.
--
-- `POST /media/images` accepts only static PNG/JPEG/WebP bytes (magic bytes + header
-- parser, max 5 MiB) and stores them in the private object bucket in the same request. It
-- creates a managed attachment owned by the caller, optionally bound to a chat, with
-- `status=READY`, `scan_status=SKIPPED` and `source=DIRECT_IMAGE`.
--
-- Schema changes:
--   * `upload_id`/`chat_id` become nullable because a direct image has no upload session
--     (and may be unbound). `upload_id` keeps its UNIQUE constraint (Postgres allows many
--     NULLs), so the regular upload pipeline is unchanged.
--   * `source` distinguishes the trusted image path from the regular upload path. It is
--     additive and backfilled: every existing row is `UPLOAD`.
--   * `ck_attachments_source_shape` prevents a direct SQL writer from creating a
--     `DIRECT_IMAGE` row without image media, or without READY/SKIPPED, and prevents a
--     regular `UPLOAD` row without upload/chat ids.
--
-- Security posture is unchanged: the table keeps ENABLE/FORCE ROW LEVEL SECURITY and the
-- existing tenant policy. No grant was widened; the direct-image caller can only insert in
-- the workspace it activated (chat membership or active workspace membership is checked by
-- the application before this row is written).
--
-- Forward-only rollback plan (only after application rollback, and only if no
-- DIRECT_IMAGE rows exist):
--   DELETE FROM file.attachments WHERE source = 'DIRECT_IMAGE';
--   ALTER TABLE file.attachments DROP CONSTRAINT ck_attachments_source_shape;
--   ALTER TABLE file.attachments DROP CONSTRAINT ck_attachments_source;
--   ALTER TABLE file.attachments ALTER COLUMN upload_id SET NOT NULL;
--   ALTER TABLE file.attachments ALTER COLUMN chat_id SET NOT NULL;
--   DROP INDEX IF EXISTS file.ix_attachments_direct_image;
--   ALTER TABLE file.attachments DROP COLUMN source;

ALTER TABLE file.attachments ALTER COLUMN chat_id DROP NOT NULL;
ALTER TABLE file.attachments ALTER COLUMN upload_id DROP NOT NULL;

ALTER TABLE file.attachments
  ADD COLUMN source text NOT NULL DEFAULT 'UPLOAD';

ALTER TABLE file.attachments
  ADD CONSTRAINT ck_attachments_source
  CHECK (source IN ('UPLOAD', 'DIRECT_IMAGE'));

ALTER TABLE file.attachments
  ADD CONSTRAINT ck_attachments_source_shape
  CHECK (
    (source = 'UPLOAD' AND upload_id IS NOT NULL AND chat_id IS NOT NULL)
    OR (
      source = 'DIRECT_IMAGE'
      AND upload_id IS NULL
      AND scan_status = 'SKIPPED'
      AND status IN ('READY', 'BOUND', 'DELETED')
      AND media IS NOT NULL
      AND media->>'kind' = 'IMAGE'
    )
  );

-- Direct images are looked up by owner when a workspace logo accepts a caller-owned image
-- from another workspace; the partial index keeps the regular attachment indexes unchanged.
CREATE INDEX ix_attachments_direct_image
  ON file.attachments (workspace_id, user_id, created_at DESC)
  WHERE source = 'DIRECT_IMAGE';

COMMENT ON COLUMN file.attachments.source IS
  '#92: UPLOAD = regular multipart/AV pipeline; DIRECT_IMAGE = trusted static PNG/JPEG/WebP '
  'stored in-request by POST /media/images (READY + SKIPPED, no upload session)';
COMMENT ON COLUMN file.attachments.upload_id IS
  'Upload session; NULL only for source = DIRECT_IMAGE';
COMMENT ON COLUMN file.attachments.chat_id IS
  'Owning chat; NULL only for an unbound DIRECT_IMAGE (user avatar / workspace logo)';
