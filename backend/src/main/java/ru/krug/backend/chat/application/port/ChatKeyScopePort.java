package ru.krug.backend.chat.application.port;

import java.util.List;
import java.util.UUID;

/**
 * Published read port for key-lifecycle notifications (E7-B1F P1-03). Returns the E2EE
 * chats in which the user is an ACTIVE member, across workspaces: revocation and device
 * registration must notify every such chat, including when the caller has no workspace
 * claim (Keycloak tokens do not carry one).
 */
public interface ChatKeyScopePort {

    List<ChatKeyScope> findE2eeChatScopes(UUID userId);

    record ChatKeyScope(UUID workspaceId, UUID chatId) {
    }
}
