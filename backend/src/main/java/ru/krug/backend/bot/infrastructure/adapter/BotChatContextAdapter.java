package ru.krug.backend.bot.infrastructure.adapter;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotChatContext;
import ru.krug.backend.bot.application.port.BotChatContextPort;

/**
 * Bot-side read of the live chat plus the installation row. It does not require membership:
 * a bot is not a user. The tenant GUC is already active (the send transaction activates it),
 * and the explicit workspace predicate hides a foreign chat as a 404.
 */
@Component
public class BotChatContextAdapter implements BotChatContextPort {

    private final EntityManager entityManager;

    public BotChatContextAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<BotChatContext> find(UUID workspaceId, UUID chatId, UUID botId) {
        if (workspaceId == null || chatId == null || botId == null) {
            return Optional.empty();
        }
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT c.workspace_id, c.security_mode, c.deleted_at,
                               (cb.bot_id IS NOT NULL) AS installed,
                               COALESCE(cb.enabled, false) AS enabled
                          FROM chat.chats c
                          LEFT JOIN bot.chat_bots cb
                            ON cb.chat_id = c.id
                           AND cb.bot_id = ?2
                           AND cb.workspace_id = c.workspace_id
                         WHERE c.id = ?1 AND c.workspace_id = ?3
                        """)
                .setParameter(1, chatId)
                .setParameter(2, botId)
                .setParameter(3, workspaceId)
                .getResultList();
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Object[] row = (Object[]) rows.get(0);
        if (row[2] != null) {
            // Soft-deleted chats are indistinguishable from missing ones.
            return Optional.empty();
        }
        return Optional.of(new BotChatContext((UUID) row[0], (String) row[1],
                Boolean.TRUE.equals(row[3]), Boolean.TRUE.equals(row[4])));
    }
}
