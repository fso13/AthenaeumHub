package ru.krug.backend.notification.application.port;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Cross-context read port for chat metadata and active members. Implemented in
 * infrastructure by delegating to the chat module's published port; notification never
 * runs SQL against chat tables.
 */
public interface ChatDirectoryPort {

    /** Trusted post-commit fan-out lookup; empty when the chat is gone. */
    Optional<ChatDirectory> findChat(UUID workspaceId, UUID chatId);

    /**
     * Resolves the workspace from the chat and verifies ACTIVE membership. Empty means the
     * caller cannot see the chat (callers map this to 403 for preference ownership).
     */
    Optional<ChatDirectory> findForMember(UUID chatId, UUID userId);

    record ChatDirectory(
            UUID chatId,
            UUID workspaceId,
            String name,
            boolean e2ee,
            List<UUID> activeMemberIds) {

        public ChatDirectory {
            activeMemberIds = activeMemberIds == null ? List.of()
                    : List.copyOf(activeMemberIds);
        }
    }
}
