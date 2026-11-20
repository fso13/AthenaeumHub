package ru.krug.backend.message.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import org.springframework.stereotype.Repository;

import ru.krug.backend.message.application.model.MentionInboxRow;
import ru.krug.backend.message.application.port.MentionInboxPort;
import ru.krug.backend.message.domain.model.MessageMention;
import ru.krug.backend.message.domain.repository.MessageMentionRepository;

/**
 * Mentions persistence (#83): inserts/read of {@code message.mentions}, plus the inbox
 * page/count/read-mark queries. The inbox query joins the chat name and the message sender in
 * one statement (no N+1) and always filters by the caller's user id, so another user's rows
 * cannot be selected even with a forged id. RLS also scopes the table to the active
 * workspace.
 */
@Repository
public class MessageMentionRepositoryAdapter
        implements MessageMentionRepository, MentionInboxPort {

    private final MessageMentionJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public MessageMentionRepositoryAdapter(MessageMentionJpaRepository jpaRepository,
                                           EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public void saveAll(List<MessageMention> mentions) {
        if (mentions == null || mentions.isEmpty()) {
            return;
        }
        jpaRepository.saveAll(mentions.stream().map(MessageMentionEntity::from).toList());
        jpaRepository.flush();
    }

    @Override
    public List<MessageMention> findByMessageIds(UUID workspaceId, List<UUID> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return List.of();
        }
        return jpaRepository.findByWorkspaceIdAndMessageIdIn(workspaceId, messageIds).stream()
                .map(MessageMentionEntity::toDomain)
                .toList();
    }

    @Override
    public List<MentionInboxRow> findPage(UUID workspaceId, UUID userId, boolean unreadOnly,
                                          Instant cursorCreatedAt, UUID cursorId,
                                          int fetchLimit) {
        StringBuilder sql = new StringBuilder("""
                SELECT mm.id, mm.chat_id, c.name AS chat_name, mm.message_id, m.sender_id,
                       m.sender_display_name, mm.mention_all, mm.read_at, mm.created_at
                  FROM message.mentions mm
                  JOIN chat.chats c
                    ON c.id = mm.chat_id AND c.workspace_id = mm.workspace_id
                  LEFT JOIN message.messages m
                    ON m.id = mm.message_id AND m.workspace_id = mm.workspace_id
                 WHERE mm.workspace_id = :workspaceId
                   AND mm.user_id = :userId
                """);
        if (unreadOnly) {
            sql.append(" AND mm.read_at IS NULL");
        }
        if (cursorCreatedAt != null && cursorId != null) {
            sql.append(" AND (mm.created_at, mm.id) < (:cursorAt, :cursorId)");
        }
        sql.append(" ORDER BY mm.created_at DESC, mm.id DESC LIMIT :fetchLimit");

        Query query = entityManager.createNativeQuery(sql.toString())
                .setParameter("workspaceId", workspaceId)
                .setParameter("userId", userId)
                .setParameter("fetchLimit", fetchLimit);
        if (cursorCreatedAt != null && cursorId != null) {
            query.setParameter("cursorAt", Timestamp.from(cursorCreatedAt));
            query.setParameter("cursorId", cursorId);
        }
        @SuppressWarnings("unchecked")
        List<Object[]> rows = query.getResultList();
        return rows.stream().map(MessageMentionRepositoryAdapter::toRow).toList();
    }

    @Override
    public long countUnread(UUID workspaceId, UUID userId) {
        Object value = entityManager.createNativeQuery("""
                        SELECT count(*) FROM message.mentions
                         WHERE workspace_id = ?1 AND user_id = ?2 AND read_at IS NULL
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .getSingleResult();
        return value == null ? 0 : ((Number) value).longValue();
    }

    @Override
    public int markRead(UUID workspaceId, UUID userId, Collection<UUID> ids, boolean all,
                        Instant now) {
        StringBuilder sql = new StringBuilder("""
                UPDATE message.mentions
                   SET read_at = :now
                 WHERE workspace_id = :workspaceId
                   AND user_id = :userId
                   AND read_at IS NULL
                """);
        if (!all) {
            sql.append(" AND id IN (:ids)");
        }
        Query query = entityManager.createNativeQuery(sql.toString())
                .setParameter("now", Timestamp.from(now))
                .setParameter("workspaceId", workspaceId)
                .setParameter("userId", userId);
        if (!all) {
            query.setParameter("ids", ids);
        }
        return query.executeUpdate();
    }

    private static MentionInboxRow toRow(Object[] row) {
        return new MentionInboxRow(uuid(row[0]), uuid(row[1]), (String) row[2], uuid(row[3]),
                uuid(row[4]), (String) row[5], Boolean.TRUE.equals(row[6]), instant(row[7]),
                instant(row[8]));
    }

    private static UUID uuid(Object value) {
        if (value == null) {
            return null;
        }
        return value instanceof UUID uuid ? uuid : UUID.fromString(value.toString());
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: "
                + value.getClass().getName());
    }
}
