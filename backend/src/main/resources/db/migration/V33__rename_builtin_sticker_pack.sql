-- Brand rename: the built-in sticker pack is shown to users as «Сова».
-- The internal slug `krug` and asset paths stay unchanged (technical compatibility),
-- only the display name and sticker alt texts change.

CREATE OR REPLACE FUNCTION sticker.ensure_builtin_catalog() RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  INSERT INTO sticker.sticker_packs (id, slug, name, cover_url, status, builtin) VALUES
    ('3a7f2fdc-306b-53c8-926d-77d90bcea67e', 'krug', 'Сова',
     '/stickers/krug/cover.png', 'ACTIVE', true),
    ('80c42b6e-6530-5a31-b47e-eaf857ebaf0e', 'cats', 'Коты',
     '/stickers/cats/cover.png', 'ACTIVE', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO sticker.stickers
    (id, pack_id, alt, url, format, width, height, size_bytes, position, status)
  VALUES
  ('a275046b-3f4d-55ca-aabe-2abb589afc93', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 1', '/stickers/krug/01.png', 'PNG', 512, 512, 26624, 1, 'ACTIVE'),
  ('2fdff577-4816-5a8e-bb77-a3efef1681e6', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 2', '/stickers/krug/02.png', 'PNG', 512, 512, 27648, 2, 'ACTIVE'),
  ('a0558008-0ea1-5768-8327-368c81a727dd', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 3', '/stickers/krug/03.png', 'PNG', 512, 512, 28672, 3, 'ACTIVE'),
  ('9bbf1c6b-08d3-5963-96c2-823ee79ad86b', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 4', '/stickers/krug/04.png', 'PNG', 512, 512, 29696, 4, 'ACTIVE'),
  ('a78fc011-c8a4-50c2-bebc-d553eec25220', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 5', '/stickers/krug/05.png', 'PNG', 512, 512, 30720, 5, 'ACTIVE'),
  ('7c7eebc9-4973-55d7-89f9-b96bdb3b07f8', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 6', '/stickers/krug/06.png', 'PNG', 512, 512, 31744, 6, 'ACTIVE'),
  ('44dac847-b04d-5991-8002-4152c046ffd6', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 7', '/stickers/krug/07.png', 'PNG', 512, 512, 32768, 7, 'ACTIVE'),
  ('6e98e652-dde0-549e-89a6-aea4f5afb775', '3a7f2fdc-306b-53c8-926d-77d90bcea67e',
   'Сова — стикер 8', '/stickers/krug/08.png', 'PNG', 512, 512, 33792, 8, 'ACTIVE'),
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

UPDATE sticker.sticker_packs
   SET name = 'Сова'
 WHERE id = '3a7f2fdc-306b-53c8-926d-77d90bcea67e'
   AND name = 'Круг';

UPDATE sticker.stickers
   SET alt = replace(alt, 'Круг', 'Сова')
 WHERE pack_id = '3a7f2fdc-306b-53c8-926d-77d90bcea67e'
   AND alt LIKE 'Круг%';
