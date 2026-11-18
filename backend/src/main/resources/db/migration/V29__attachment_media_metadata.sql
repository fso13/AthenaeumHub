-- D1-BE2: attachment media metadata (artwork/title/artist/duration/dimensions).
--
-- MVP scope (docs/TASKS-DASHBOARD-V1.md §3.3, §5):
--   * MANAGED only. The client may supply already-parsed ID3/fallback metadata with the
--     upload init; the server sanitizes it and stores it as jsonb. There is no ffprobe or
--     other server-side media parsing in this slice (that is D1.1).
--   * E2EE attachments are out of this slice. The upload API rejects every non-MANAGED
--     encryption_mode before the media payload is parsed, so no plaintext metadata can be
--     stored for an E2EE chat.
--   * media is nullable: legacy attachments and plain files never carry it.
--
-- The column lives on both uploads (the metadata travels with the resumable session) and
-- attachments (the immutable message-facing copy). complete copies uploads.media into
-- attachments.media; the DB check is the last line of defence for direct SQL writers.
--
-- Strings are bounded and HTML-free, duration/dimensions are integer and bounded, artwork
-- is an http(s) URL. The server never fetches artwork_url, so there is no server-side SSRF;
-- the application additionally rejects loopback/private/link-local hosts.

ALTER TABLE file.uploads
  ADD COLUMN IF NOT EXISTS media jsonb;

ALTER TABLE file.attachments
  ADD COLUMN IF NOT EXISTS media jsonb;

CREATE OR REPLACE FUNCTION file.media_metadata_valid(media jsonb)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT media IS NULL OR (
    jsonb_typeof(media) = 'object'
    AND media ? 'kind'
    AND media->>'kind' IN ('AUDIO', 'VIDEO', 'IMAGE', 'FILE')
    AND media ? 'metadata_source'
    AND media->>'metadata_source' IN ('ID3', 'SERVER', 'CLIENT', 'NONE')
    AND (
      NOT media ? 'duration_ms'
      OR media->'duration_ms' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'duration_ms') = 'number'
        AND media->>'duration_ms' ~ '^[0-9]+$'
        AND (media->>'duration_ms')::numeric <= 604800000
      )
    )
    AND (
      NOT media ? 'width'
      OR media->'width' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'width') = 'number'
        AND media->>'width' ~ '^[0-9]+$'
        AND (media->>'width')::numeric BETWEEN 1 AND 16384
      )
    )
    AND (
      NOT media ? 'height'
      OR media->'height' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'height') = 'number'
        AND media->>'height' ~ '^[0-9]+$'
        AND (media->>'height')::numeric BETWEEN 1 AND 16384
      )
    )
    AND (
      NOT media ? 'title'
      OR media->'title' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'title') = 'string'
        AND char_length(media->>'title') BETWEEN 1 AND 255
        AND media->>'title' !~ '[<>]'
        AND media->>'title' !~ '[[:cntrl:]]'
      )
    )
    AND (
      NOT media ? 'artist'
      OR media->'artist' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'artist') = 'string'
        AND char_length(media->>'artist') BETWEEN 1 AND 255
        AND media->>'artist' !~ '[<>]'
        AND media->>'artist' !~ '[[:cntrl:]]'
      )
    )
    AND (
      NOT media ? 'album'
      OR media->'album' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'album') = 'string'
        AND char_length(media->>'album') BETWEEN 1 AND 255
        AND media->>'album' !~ '[<>]'
        AND media->>'album' !~ '[[:cntrl:]]'
      )
    )
    AND (
      NOT media ? 'genre'
      OR media->'genre' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'genre') = 'string'
        AND char_length(media->>'genre') BETWEEN 1 AND 64
        AND media->>'genre' !~ '[<>]'
        AND media->>'genre' !~ '[[:cntrl:]]'
      )
    )
    AND (
      NOT media ? 'year'
      OR media->'year' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'year') = 'string'
        AND media->>'year' ~ '^[0-9]{4}$'
      )
    )
    AND (
      NOT media ? 'artwork_url'
      OR media->'artwork_url' = 'null'::jsonb
      OR (
        jsonb_typeof(media->'artwork_url') = 'string'
        AND char_length(media->>'artwork_url') BETWEEN 1 AND 2048
        AND media->>'artwork_url' ~ '^https?://'
        AND media->>'artwork_url' !~ '[[:space:]<>]'
      )
    )
  )
$$;

COMMENT ON FUNCTION file.media_metadata_valid(jsonb) IS
  'D1-BE2: shape/bounds backstop for attachment media metadata (no parsing, no I/O).';

ALTER TABLE file.uploads
  DROP CONSTRAINT IF EXISTS ck_uploads_media_valid;
ALTER TABLE file.uploads
  ADD CONSTRAINT ck_uploads_media_valid
  CHECK (file.media_metadata_valid(media));

ALTER TABLE file.attachments
  DROP CONSTRAINT IF EXISTS ck_attachments_media_valid;
ALTER TABLE file.attachments
  ADD CONSTRAINT ck_attachments_media_valid
  CHECK (file.media_metadata_valid(media));

-- Files page filtering by kind is a read pattern for D1-FE4; the partial index keeps
-- legacy/plain attachments out of the index and never needs a table rewrite.
CREATE INDEX IF NOT EXISTS ix_attachments_media_kind
  ON file.attachments (workspace_id, (media->>'kind'))
  WHERE media IS NOT NULL;
