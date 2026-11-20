-- Replace the built-in «Сова» art with the provided owl pack and remove cats.
-- The eight original sticker ids/URLs are kept for compatibility; the new art
-- overwrites the PNG files and three extra owl stickers are appended.
DELETE FROM sticker.sticker_favorites WHERE sticker_id IN (
  SELECT id FROM sticker.stickers
   WHERE pack_id = '80c42b6e-6530-5a31-b47e-eaf857ebaf0e');
DELETE FROM sticker.stickers
 WHERE pack_id = '80c42b6e-6530-5a31-b47e-eaf857ebaf0e';
DELETE FROM sticker.sticker_packs
 WHERE id = '80c42b6e-6530-5a31-b47e-eaf857ebaf0e';

UPDATE sticker.sticker_packs
   SET name = 'Сова', cover_url = '/stickers/krug/09.png'
 WHERE id = '3a7f2fdc-306b-53c8-926d-77d90bcea67e';

INSERT INTO sticker.stickers
  (id, pack_id, alt, url, format, width, height, size_bytes, position, status)
VALUES
  ('c0000000-0000-4000-8000-000000000009', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова: привет', '/stickers/krug/09.png', 'PNG', 512, 512, 283142, 9, 'ACTIVE'),
  ('c0000000-0000-4000-8000-00000000000a', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова: созвон', '/stickers/krug/10.png', 'PNG', 512, 512, 283521, 10, 'ACTIVE'),
  ('c0000000-0000-4000-8000-00000000000b', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова: утренний кофе', '/stickers/krug/11.png', 'PNG', 512, 512, 306888, 11, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION sticker.ensure_builtin_catalog() RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  INSERT INTO sticker.sticker_packs (id, slug, name, cover_url, status, builtin) VALUES
    ('3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'krug', 'Сова',
     '/stickers/krug/09.png', 'ACTIVE', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO sticker.stickers
    (id, pack_id, alt, url, format, width, height, size_bytes, position, status)
  VALUES
    ('a275046b-3f4d-55ca-aabe-2abb589afc93', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 1', '/stickers/krug/01.png', 'PNG', 512, 512, 247815, 1, 'ACTIVE'),
    ('2fdff577-4816-5a8e-bb77-a3efef1681e6', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 2', '/stickers/krug/02.png', 'PNG', 512, 512, 320414, 2, 'ACTIVE'),
    ('a0558008-0ea1-5768-8327-368c81a727dd', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 3', '/stickers/krug/03.png', 'PNG', 512, 512, 328062, 3, 'ACTIVE'),
    ('9bbf1c6b-08d3-5963-96c2-823ee79ad86b', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 4', '/stickers/krug/04.png', 'PNG', 512, 512, 310822, 4, 'ACTIVE'),
    ('a78fc011-c8a4-50c2-bebc-d553eec25220', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 5', '/stickers/krug/05.png', 'PNG', 512, 512, 272373, 5, 'ACTIVE'),
    ('7c7eebc9-4973-55d7-89f9-b96bdb3b07f8', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 6', '/stickers/krug/06.png', 'PNG', 512, 512, 223372, 6, 'ACTIVE'),
    ('44dac847-b04d-5991-8002-4152c046ffd6', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 7', '/stickers/krug/07.png', 'PNG', 512, 512, 352380, 7, 'ACTIVE'),
    ('6e98e652-dde0-549e-89a6-aea4f5afb775', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова — стикер 8', '/stickers/krug/08.png', 'PNG', 512, 512, 274452, 8, 'ACTIVE'),
    ('c0000000-0000-4000-8000-000000000009', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова: привет', '/stickers/krug/09.png', 'PNG', 512, 512, 283142, 9, 'ACTIVE'),
    ('c0000000-0000-4000-8000-00000000000a', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова: созвон', '/stickers/krug/10.png', 'PNG', 512, 512, 283521, 10, 'ACTIVE'),
    ('c0000000-0000-4000-8000-00000000000b', '3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'Сова: утренний кофе', '/stickers/krug/11.png', 'PNG', 512, 512, 306888, 11, 'ACTIVE')
  ON CONFLICT (id) DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION sticker.ensure_builtin_catalog() TO krug_app;
