-- #193: repair room rows whose backing chat was soft-deleted outside the room
-- close flow. A broken room must not stay ACTIVE and offer a 404 avatar target.
UPDATE room.rooms r
SET status = 'CLOSED', updated_at = now()
FROM chat.chats c
WHERE r.chat_id = c.id
  AND r.status = 'ACTIVE'
  AND c.deleted_at IS NOT NULL;
