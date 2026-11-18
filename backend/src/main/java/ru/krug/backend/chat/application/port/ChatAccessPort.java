package ru.krug.backend.chat.application.port;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.chat.application.model.ChatAccess;

public interface ChatAccessPort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException 403 without workspace membership,
     *         404 when the chat is not accessible (existence hidden).
     */
    ChatAccess requireActiveChat(UUID workspaceId, UUID chatId, UUID userId);

    /**
     * Non-throwing variant used by transports that must answer {@code accepted:false}
     * without starting a rollback-only transaction (for example the WS subscription gate).
     */
    Optional<ChatAccess> findActiveChat(UUID workspaceId, UUID chatId, UUID userId);
}
