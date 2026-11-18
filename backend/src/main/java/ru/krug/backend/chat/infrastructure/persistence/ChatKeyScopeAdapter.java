package ru.krug.backend.chat.infrastructure.persistence;

import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.port.ChatKeyScopePort;

/**
 * Reads the caller's E2EE chat scopes through the {@code chat.e2ee_chat_scopes} SECURITY
 * DEFINER function (V17). A plain SQL join would be RLS-bound to the current workspace and
 * would return nothing for a revocation performed without a workspace claim.
 */
@Component
public class ChatKeyScopeAdapter implements ChatKeyScopePort {

    private final EntityManager entityManager;

    public ChatKeyScopeAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<ChatKeyScope> findE2eeChatScopes(UUID userId) {
        if (userId == null) {
            return List.of();
        }
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, chat_id FROM chat.e2ee_chat_scopes(?1)
                        """)
                .setParameter(1, userId)
                .getResultList();
        return rows.stream()
                .map(row -> new ChatKeyScope((UUID) row[0], (UUID) row[1]))
                .toList();
    }
}
