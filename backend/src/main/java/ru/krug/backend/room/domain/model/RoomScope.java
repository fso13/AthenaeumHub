package ru.krug.backend.room.domain.model;

import java.util.UUID;

/**
 * Authorization context of one room resolved before the workspace RLS GUC is known.
 * Produced by {@code room.room_scope(room_id, user_id)}; the actor is always an ACTIVE
 * member of an ACTIVE workspace.
 */
public record RoomScope(
        UUID workspaceId,
        String workspaceRole,
        String roomStatus,
        UUID createdBy,
        UUID chatId) {
}
