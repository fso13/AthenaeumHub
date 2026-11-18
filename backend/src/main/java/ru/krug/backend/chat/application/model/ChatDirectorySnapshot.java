package ru.krug.backend.chat.application.model;

import java.util.List;
import java.util.UUID;

/**
 * Read model for notification fan-out: chat name, mode and the ACTIVE member ids.
 * Deliberately contains no message content.
 */
public record ChatDirectorySnapshot(
        UUID chatId,
        UUID workspaceId,
        String name,
        boolean e2ee,
        List<UUID> activeMemberIds) {

    public ChatDirectorySnapshot {
        activeMemberIds = activeMemberIds == null ? List.of() : List.copyOf(activeMemberIds);
    }
}
