-- Admin-managed file extension allowlist (M4A + runtime settings).
--
-- Design notes:
--   * ops.system_settings stays a global singleton; the allowlist is installation
--     configuration, not workspace data.
--   * The default mirrors the pre-V32 safe policy and adds M4A. It is the same list as
--     ru.krug.backend.shared.domain.model.AllowedFileExtensions.DEFAULTS; MigrationsIT
--     asserts that the column default contains every Java default entry.
--   * text[] (not jsonb) keeps the setting a flat, ordered list; the application maps it
--     with array_to_string/string_to_array. The DB CHECK is a backstop for every write
--     path (including future admin tooling), while the domain value object is the primary
--     validation gate.
--   * Dangerous extensions are rejected by the check function too: an admin can never
--     allowlist an executable/active-content extension, so the existing dangerous block
--     cannot be weakened through settings.
--   * Forward-only rollback plan:
--       ALTER TABLE ops.system_settings
--         DROP CONSTRAINT ck_system_settings_allowed_file_extensions,
--         DROP COLUMN allowed_file_extensions;
--       DROP FUNCTION ops.allowed_file_extensions_valid(text[]);
--     The setting (not user content) is lost on rollback; uploads fall back to the
--     hard-coded pre-V32 policy only after an application rollback.

CREATE OR REPLACE FUNCTION ops.allowed_file_extensions_valid(extensions text[])
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $$
  SELECT extensions IS NOT NULL
     AND cardinality(extensions) BETWEEN 1 AND 100
     AND NOT EXISTS (
           SELECT 1
             FROM unnest(extensions) AS entry(ext)
            WHERE entry.ext IS NULL
               OR entry.ext !~ '^[a-z0-9]{1,10}$'
               OR entry.ext = ANY (ARRAY[
                    'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'ps1', 'sh', 'bash',
                    'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'dll', 'sys', 'apk', 'jar',
                    'app', 'deb', 'rpm', 'hta', 'cpl', 'lnk',
                    'html', 'htm', 'xhtml', 'shtml', 'svg'
                  ]::text[])
         )
     AND cardinality(extensions) = (
           SELECT count(DISTINCT entry.ext)
             FROM unnest(extensions) AS entry(ext)
         )
  $$;

REVOKE ALL ON FUNCTION ops.allowed_file_extensions_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.allowed_file_extensions_valid(text[]) TO krug_app;

ALTER TABLE ops.system_settings
  ADD COLUMN allowed_file_extensions text[] NOT NULL
    DEFAULT ARRAY[
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic',
      'heif', 'ico',
      'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba', 'wma',
      'aiff', 'amr',
      'mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp',
      'pdf', 'txt', 'csv', 'tsv', 'rtf', 'json', 'xml', 'md', 'markdown', 'log',
      'yaml', 'yml', 'toml',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
      'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz',
      'bin', 'dat', 'fig', 'epub', 'mobi', 'srt', 'vtt', 'ics', 'vcf'
    ]::text[],
  ADD CONSTRAINT ck_system_settings_allowed_file_extensions
    CHECK (ops.allowed_file_extensions_valid(allowed_file_extensions));

COMMENT ON COLUMN ops.system_settings.allowed_file_extensions IS
  'Admin-managed lowercase file extensions (1..100, [a-z0-9]{1,10}, no dots/duplicates); '
  'dangerous extensions are rejected by ck_system_settings_allowed_file_extensions.';
