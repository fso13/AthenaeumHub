-- #199: personal "Избранное" is a DIRECT self-chat with key `<id>:<id>`.
ALTER TABLE chat.chats DROP CONSTRAINT ck_chats_direct_key_format;
ALTER TABLE chat.chats
  ADD CONSTRAINT ck_chats_direct_key_format CHECK (
    type <> 'DIRECT' OR (
      direct_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND split_part(direct_key, ':', 1) <= split_part(direct_key, ':', 2)
    )
  );
