package ru.krug.backend.message.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.message.domain.model.MessageReaction;
import ru.krug.backend.message.domain.repository.MessageReactionRepository;

/**
 * Native reaction storage. A page uses exactly one aggregation query, independent of the
 * number of messages; the {@code me} flag is computed in SQL for the caller.
 */
@Repository
public class MessageReactionRepositoryAdapter implements MessageReactionRepository {

    private final EntityManager entityManager;

    public MessageReactionRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void add(UUID workspaceId, UUID chatId, UUID messageId, UUID userId, String emoji,
                    Instant createdAt) {
        entityManager.createNativeQuery("""
                        INSERT INTO message.message_reactions
                               (message_id, workspace_id, chat_id, user_id, emoji, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                        ON CONFLICT (message_id, user_id, emoji) DO NOTHING
                        """)
                .setParameter(1, messageId)
                .setParameter(2, workspaceId)
                .setParameter(3, chatId)
                .setParameter(4, userId)
                .setParameter(5, emoji)
                .setParameter(6, Timestamp.from(createdAt))
                .executeUpdate();
    }

    @Override
    public void remove(UUID workspaceId, UUID chatId, UUID messageId, UUID userId, String emoji) {
        entityManager.createNativeQuery("""
                        DELETE FROM message.message_reactions
                         WHERE workspace_id = ?1 AND chat_id = ?2 AND message_id = ?3
                           AND user_id = ?4 AND emoji = ?5
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, messageId)
                .setParameter(4, userId)
                .setParameter(5, emoji)
                .executeUpdate();
    }

    @Override
    public long count(UUID workspaceId, UUID messageId, String emoji) {
        Object count = entityManager.createNativeQuery("""
                        SELECT count(*) FROM message.message_reactions
                         WHERE workspace_id = ?1 AND message_id = ?2 AND emoji = ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, messageId)
                .setParameter(3, emoji)
                .getSingleResult();
        return ((Number) count).longValue();
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<UUID> users(UUID workspaceId, UUID messageId, String emoji) {
        return entityManager.createNativeQuery("""
                        SELECT user_id FROM message.message_reactions
                         WHERE workspace_id = ?1 AND message_id = ?2 AND emoji = ?3
                         ORDER BY created_at ASC, user_id ASC
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, messageId)
                .setParameter(3, emoji)
                .getResultList();
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<UUID, List<MessageReaction>> summarize(UUID workspaceId,
                                                      Collection<UUID> messageIds,
                                                      UUID viewerId) {
        if (messageIds == null || messageIds.isEmpty()) {
            return Map.of();
        }
        List<UUID> ids = List.copyOf(new LinkedHashSet<>(messageIds));
        StringBuilder sql = new StringBuilder("""
                SELECT message_id, emoji, count(*) AS reaction_count,
                       bool_or(user_id = ?2) AS mine
                  FROM message.message_reactions
                 WHERE workspace_id = ?1
                   AND message_id IN (""");
        for (int i = 0; i < ids.size(); i++) {
            sql.append(i == 0 ? "" : ", ").append('?').append(i + 3);
        }
        sql.append(") GROUP BY message_id, emoji ORDER BY message_id, min(created_at), emoji");
        var query = entityManager.createNativeQuery(sql.toString())
                .setParameter(1, workspaceId)
                .setParameter(2, viewerId);
        for (int i = 0; i < ids.size(); i++) {
            query.setParameter(i + 3, ids.get(i));
        }
        List<Object[]> rows = query.getResultList();
        Map<UUID, List<MessageReaction>> result = new LinkedHashMap<>();
        for (Object[] row : rows) {
            UUID messageId = (UUID) row[0];
            String emoji = (String) row[1];
            long count = ((Number) row[2]).longValue();
            boolean me = Boolean.TRUE.equals(row[3]);
            result.computeIfAbsent(messageId, id -> new ArrayList<>())
                    .add(new MessageReaction(emoji, count, me));
        }
        return result;
    }

    @Override
    public void deleteForMessage(UUID workspaceId, UUID messageId) {
        entityManager.createNativeQuery("""
                        DELETE FROM message.message_reactions
                         WHERE workspace_id = ?1 AND message_id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, messageId)
                .executeUpdate();
    }
}
