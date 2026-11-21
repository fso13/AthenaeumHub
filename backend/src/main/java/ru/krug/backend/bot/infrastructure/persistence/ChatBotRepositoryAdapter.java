package ru.krug.backend.bot.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.bot.domain.model.ChatBot;
import ru.krug.backend.bot.domain.repository.ChatBotRepository;

/** Native JDBC mapping for {@code bot.chat_bots}; RLS-scoped by the caller's tenant GUC. */
@Repository
public class ChatBotRepositoryAdapter implements ChatBotRepository {

    private final EntityManager entityManager;

    public ChatBotRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<ChatBot> find(UUID workspaceId, UUID chatId, UUID botId) {
        if (workspaceId == null || chatId == null || botId == null) {
            return Optional.empty();
        }
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, chat_id, bot_id, enabled, installed_by,
                               installed_at, updated_at
                          FROM bot.chat_bots
                         WHERE workspace_id = ?1 AND chat_id = ?2 AND bot_id = ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, botId)
                .getResultList();
        return rows.stream().findFirst().map(ChatBotRepositoryAdapter::toDomain);
    }

    @Override
    public List<ChatBot> findByChat(UUID workspaceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, chat_id, bot_id, enabled, installed_by,
                               installed_at, updated_at
                          FROM bot.chat_bots
                         WHERE workspace_id = ?1 AND chat_id = ?2
                         ORDER BY installed_at, bot_id
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .getResultList();
        return rows.stream().map(ChatBotRepositoryAdapter::toDomain).toList();
    }

    @Override
    public boolean install(UUID workspaceId, UUID chatId, UUID botId, UUID installedBy,
                           Instant now) {
        int inserted = entityManager.createNativeQuery("""
                        INSERT INTO bot.chat_bots
                               (workspace_id, chat_id, bot_id, enabled, installed_by,
                                installed_at, updated_at)
                        VALUES (?1, ?2, ?3, true, ?4, ?5, ?5)
                        ON CONFLICT (chat_id, bot_id) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, botId)
                .setParameter(4, installedBy)
                .setParameter(5, Timestamp.from(now))
                .executeUpdate();
        return inserted == 1;
    }

    @Override
    public boolean uninstall(UUID workspaceId, UUID chatId, UUID botId) {
        int deleted = entityManager.createNativeQuery("""
                        DELETE FROM bot.chat_bots
                         WHERE workspace_id = ?1 AND chat_id = ?2 AND bot_id = ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, botId)
                .executeUpdate();
        return deleted > 0;
    }

    private static ChatBot toDomain(Object[] row) {
        return ChatBot.reconstitute((UUID) row[0], (UUID) row[1], (UUID) row[2],
                Boolean.TRUE.equals(row[3]), (UUID) row[4], instant(row[5]), instant(row[6]));
    }

    private static Instant instant(Object value) {
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        throw new IllegalStateException("Unsupported chat-bot timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }
}
