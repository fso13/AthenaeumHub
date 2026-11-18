package ru.krug.backend.chat.application.port;

import java.util.Optional;
import java.util.UUID;

/** Published port used by message handlers to bind a Keycloak principal to a chat. */
public interface ChatWorkspacePort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException 404 when the chat is missing or
     *         the user is not an active member (existence is not disclosed).
     */
    UUID workspaceForChat(UUID chatId, UUID userId, String requestId);

    /**
     * Non-throwing variant for transports that treat a missing membership as
     * {@code accepted:false} instead of an error.
     */
    Optional<UUID> findWorkspaceForChat(UUID chatId, UUID userId);
}
