-- #104: self-hosted LibreTranslate as a first-class translation provider.
--
-- provider selects the outbound wire protocol:
--   AUTO          - detect by URL path (/translate => LibreTranslate, otherwise custom)
--   CUSTOM        - legacy POST {text,target} -> {text}
--   LIBRETRANSLATE- POST {q,source,target,format} -> {translatedText}
--
-- Existing rows keep the historical custom contract semantics through AUTO. No secret
-- column is added: the provider is still addressed only by URL.
ALTER TABLE ops.plugin_translation_settings
  ADD COLUMN provider text NOT NULL DEFAULT 'AUTO'
  CHECK (provider IN ('AUTO', 'CUSTOM', 'LIBRETRANSLATE'));

COMMENT ON COLUMN ops.plugin_translation_settings.provider IS
  '#104 wire protocol selector: AUTO (path detection), CUSTOM or LIBRETRANSLATE; no secret';
