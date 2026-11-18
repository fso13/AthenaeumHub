package ru.krug.backend.chat.application.port;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;

/**
 * Published read port for consumers that need chat metadata/members (notification
 * fan-out). Keeps notification free of cross-module SQL and chat domain coupling.
 */
public interface ChatMemberDirectoryPort {

    /**
     * @return chat snapshot when the chat exists and is not deleted; the caller is
     *         responsible for activating the workspace RLS context.
     */
    Optional<ChatDirectorySnapshot> find(UUID workspaceId, UUID chatId);
}
