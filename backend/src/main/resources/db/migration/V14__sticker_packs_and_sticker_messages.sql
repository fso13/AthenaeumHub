-- E5-B: built-in sticker packs, per-user favorites and STICKER messages.
--
-- Ownership:
--   * sticker.sticker_packs / sticker.stickers are global built-in catalog rows
--     (workspace_id is NULL by design, SYSTEM-ANALYSIS §6.5). They are read-only for
--     krug_app and seeded here by the migrator; E5 is managed + built-in only.
--   * sticker.sticker_favorites is per user and protected by forced RLS
--     (user_id = ops.current_user_id()), so cross-device favorites never leak.
--   * message.messages.type gains STICKER; a STICKER row carries exactly one sticker_id,
--     no body ciphertext and no attachments (attachments are rejected by the application).

CREATE SCHEMA IF NOT EXISTS sticker;
GRANT USAGE ON SCHEMA sticker TO krug_app;

CREATE TABLE sticker.sticker_packs (
  id          uuid PRIMARY KEY,
  slug        citext NOT NULL UNIQUE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  cover_url   text NOT NULL CHECK (length(cover_url) BETWEEN 1 AND 1024),
  status      text NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('DRAFT', 'IN_REVIEW', 'ACTIVE', 'DISABLED', 'REJECTED',
                                'REMOVED')),
  builtin     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_sticker_packs_status ON sticker.sticker_packs (status);
CREATE INDEX ix_sticker_packs_builtin ON sticker.sticker_packs (builtin)
  WHERE builtin;

CREATE TABLE sticker.stickers (
  id          uuid PRIMARY KEY,
  pack_id     uuid NOT NULL REFERENCES sticker.sticker_packs(id) ON DELETE CASCADE,
  alt         text NOT NULL CHECK (length(alt) BETWEEN 1 AND 120),
  url         text NOT NULL CHECK (length(url) BETWEEN 1 AND 1024),
  format      text NOT NULL CHECK (format IN ('PNG', 'WEBP', 'APNG')),
  width       integer NOT NULL CHECK (width = 512),
  height      integer NOT NULL CHECK (height = 512),
  -- SYSTEM-ANALYSIS §12.7: 512x512, <=512 KiB, SVG/HTML never allowed.
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 524288),
  position    integer NOT NULL CHECK (position > 0),
  status      text NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE', 'DISABLED', 'REMOVED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, position),
  UNIQUE (pack_id, url)
);

CREATE INDEX ix_stickers_pack_position ON sticker.stickers (pack_id, position);
CREATE INDEX ix_stickers_status ON sticker.stickers (status);

CREATE TABLE sticker.sticker_favorites (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sticker_id  uuid NOT NULL REFERENCES sticker.stickers(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sticker_id)
);

CREATE INDEX ix_sticker_favorites_user_created
  ON sticker.sticker_favorites (user_id, created_at DESC);

-- Built-in catalog is global and read-only for the runtime role.
GRANT SELECT ON sticker.sticker_packs, sticker.stickers TO krug_app;

-- Favorites are user-scoped: no workspace_id, RLS by the current user GUC.
ALTER TABLE sticker.sticker_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sticker.sticker_favorites FORCE ROW LEVEL SECURITY;
CREATE POLICY p_sticker_favorites_owner ON sticker.sticker_favorites
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, DELETE ON sticker.sticker_favorites TO krug_app;

-- Seed: two built-in packs x 8 PNG stickers. IDs are deterministic UUIDv5 values so
-- listings, messages and tests can reference them without a lookup. URLs are absolute
-- paths served by the web client's public assets (managed only; no upload in E5).
--
-- The seed lives in a SECURITY DEFINER function so the startup loader (krug_app) can
-- repair an empty catalog without owning INSERT on the global tables. Re-running is
-- idempotent (ON CONFLICT DO NOTHING).
CREATE OR REPLACE FUNCTION sticker.ensure_builtin_catalog() RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  INSERT INTO sticker.sticker_packs (id, slug, name, cover_url, status, builtin) VALUES
    ('3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'krug', 'Круг',
     '/stickers/krug/cover.png', 'ACTIVE', true),
    ('80c42b6e-6530-5a31-b47e-eaf857ebaf0e', 'cats', 'Коты',
     '/stickers/cats/cover.png', 'ACTIVE', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO sticker.stickers
    (id, pack_id, alt, url, format, width, height, size_bytes, position, status)
  VALUES
  ('a275046b-3f4d-55ca-aabe-2abb589afc93', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 1', '/stickers/krug/01.png', 'PNG', 512, 512, 26624, 1, 'ACTIVE'),
  ('2fdff577-4816-5a8e-bb77-a3efef1681e6', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 2', '/stickers/krug/02.png', 'PNG', 512, 512, 27648, 2, 'ACTIVE'),
  ('a0558008-0ea1-5768-8327-368c81a727dd', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 3', '/stickers/krug/03.png', 'PNG', 512, 512, 28672, 3, 'ACTIVE'),
  ('9bbf1c6b-08d3-5963-96c2-823ee79ad86b', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 4', '/stickers/krug/04.png', 'PNG', 512, 512, 29696, 4, 'ACTIVE'),
  ('a78fc011-c8a4-50c2-bebc-d553eec25220', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 5', '/stickers/krug/05.png', 'PNG', 512, 512, 30720, 5, 'ACTIVE'),
  ('7c7eebc9-4973-55d7-89f9-b96bdb3b07f8', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 6', '/stickers/krug/06.png', 'PNG', 512, 512, 31744, 6, 'ACTIVE'),
  ('44dac847-b04d-5991-8002-4152c046ffd6', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 7', '/stickers/krug/07.png', 'PNG', 512, 512, 32768, 7, 'ACTIVE'),
  ('6e98e652-dde0-549e-89a6-aea4f5afb775', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Круг — стикер 8', '/stickers/krug/08.png', 'PNG', 512, 512, 33792, 8, 'ACTIVE'),
  ('e23ed071-3a99-53a6-a507-e9f4a1c7a451', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 1', '/stickers/cats/01.png', 'PNG', 512, 512, 26624, 1, 'ACTIVE'),
  ('2ba4dd4b-00b3-54d3-b2e7-42d5c8237e84', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 2', '/stickers/cats/02.png', 'PNG', 512, 512, 27648, 2, 'ACTIVE'),
  ('21fd4751-a49e-5472-bdbb-980f3a95cf66', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 3', '/stickers/cats/03.png', 'PNG', 512, 512, 28672, 3, 'ACTIVE'),
  ('555bc98b-74fd-55de-8b51-0bf46f3479b0', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 4', '/stickers/cats/04.png', 'PNG', 512, 512, 29696, 4, 'ACTIVE'),
  ('1d931ca3-7cef-5dc2-ab22-efcf719ee331', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 5', '/stickers/cats/05.png', 'PNG', 512, 512, 30720, 5, 'ACTIVE'),
  ('d76252f8-7105-5b57-ae2c-00399a0502c7', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 6', '/stickers/cats/06.png', 'PNG', 512, 512, 31744, 6, 'ACTIVE'),
  ('a53f9e7e-f667-58f6-ae32-22f1e7267616', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 7', '/stickers/cats/07.png', 'PNG', 512, 512, 32768, 7, 'ACTIVE'),
  ('b8778a3f-f769-59c5-8cf1-e86f9f1ade68', '80c42b6e-6530-5a31-b47e-eaf857ebaf0e',
   'Кот — стикер 8', '/stickers/cats/08.png', 'PNG', 512, 512, 33792, 8, 'ACTIVE')
  ON CONFLICT (id) DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION sticker.ensure_builtin_catalog() TO krug_app;

SELECT sticker.ensure_builtin_catalog();

-- STICKER messages: one sticker, no body, no attachments. TEXT keeps its optional body
-- (E4-B attachment-only messages); SYSTEM stays body-less.
ALTER TABLE message.messages ADD COLUMN IF NOT EXISTS sticker_id uuid;

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_type
  CHECK (type IN ('TEXT', 'STICKER', 'SYSTEM'));

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_sticker_present;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_sticker_present
  CHECK (type <> 'STICKER' OR sticker_id IS NOT NULL);

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_sticker_only;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_sticker_only
  CHECK (type = 'STICKER' OR sticker_id IS NULL);

ALTER TABLE message.messages DROP CONSTRAINT IF EXISTS ck_messages_sticker_no_body;
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_sticker_no_body
  CHECK (type <> 'STICKER' OR body_ciphertext IS NULL);

CREATE INDEX IF NOT EXISTS ix_messages_sticker
  ON message.messages (sticker_id) WHERE sticker_id IS NOT NULL;

COMMENT ON COLUMN message.messages.sticker_id IS
  'E5-B: built-in sticker reference; non-null iff type = STICKER';
