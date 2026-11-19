package ru.krug.backend.message.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Repository;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.ThreadSummary;
import ru.krug.backend.message.domain.repository.MessageRepository;

@Repository
public class MessageRepositoryAdapter implements MessageRepository {

    private static final Logger log = LoggerFactory.getLogger(MessageRepositoryAdapter.class);

    private final MessageJpaRepository jpaRepository;
    private final MessagePersistenceMapper mapper;
    private final EntityManager entityManager;
    private final MessageCipher cipher;

    public MessageRepositoryAdapter(MessageJpaRepository jpaRepository,
                                    MessagePersistenceMapper mapper,
                                    EntityManager entityManager,
                                    MessageCipher cipher) {
        this.jpaRepository = jpaRepository;
        this.mapper = mapper;
        this.entityManager = entityManager;
        this.cipher = cipher;
    }

    @Override
    public void save(Message message) {
        entityManager.persist(mapper.toEntity(message));
    }

    @Override
    public Optional<Message> findById(UUID workspaceId, UUID messageId) {
        return jpaRepository.findByIdAndWorkspaceId(messageId, workspaceId)
                .map(mapper::toDomain);
    }

    @Override
    public Optional<Message> findByClientMessageId(UUID workspaceId, UUID chatId,
                                                   UUID clientMessageId, UUID senderId) {
        return jpaRepository.findByWorkspaceIdAndChatIdAndSenderIdAndClientMessageId(
                        workspaceId, chatId, senderId, clientMessageId)
                .map(mapper::toDomain);
    }

    @Override
    public Optional<UUID> findSenderIdByClientMessageId(UUID workspaceId, UUID chatId,
                                                        UUID clientMessageId) {
        return jpaRepository.findSenderIdByClientMessageId(workspaceId, chatId, clientMessageId);
    }

    @Override
    public Optional<UUID> findChatIdByMessageId(UUID workspaceId, UUID chatId, UUID messageId) {
        return jpaRepository.findChatId(workspaceId, chatId, messageId);
    }

    @Override
    public void hideForUser(UUID workspaceId, UUID chatId, UUID messageId, UUID userId,
                            Instant deletedAt) {
        entityManager.createNativeQuery("""
                        INSERT INTO message.message_deletions
                               (message_id, workspace_id, chat_id, user_id, deleted_at)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT (message_id, user_id) DO NOTHING
                        """)
                .setParameter(1, messageId)
                .setParameter(2, workspaceId)
                .setParameter(3, chatId)
                .setParameter(4, userId)
                .setParameter(5, Timestamp.from(deletedAt))
                .executeUpdate();
    }

    @Override
    public boolean isHiddenForUser(UUID workspaceId, UUID messageId, UUID userId) {
        Object count = entityManager.createNativeQuery("""
                        SELECT count(*) FROM message.message_deletions
                         WHERE workspace_id = ?1 AND message_id = ?2 AND user_id = ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, messageId)
                .setParameter(3, userId)
                .getSingleResult();
        return ((Number) count).longValue() > 0;
    }

    @Override
    public Optional<Message> editText(UUID workspaceId, UUID chatId, UUID messageId, String text,
                                      Integer expectedVersion, Instant editedAt) {
        byte[] ciphertext = cipher.encrypt(text,
                MessageCipher.aad(workspaceId, chatId, messageId));
        StringBuilder sql = new StringBuilder("""
                UPDATE message.messages
                   SET body_ciphertext = ?1,
                       content_meta = jsonb_build_object('length', ?2),
                       edited_at = ?3,
                       version = version + 1
                 WHERE id = ?4 AND workspace_id = ?5 AND chat_id = ?6
                   AND deleted_at IS NULL
                   AND type = 'TEXT' AND crypto_scheme = 'MANAGED'
                """);
        if (expectedVersion != null) {
            sql.append(" AND version = ?7");
        }
        Query query = entityManager.createNativeQuery(sql.toString())
                .setParameter(1, ciphertext)
                .setParameter(2, text.length())
                .setParameter(3, Timestamp.from(editedAt))
                .setParameter(4, messageId)
                .setParameter(5, workspaceId)
                .setParameter(6, chatId);
        if (expectedVersion != null) {
            query.setParameter(7, expectedVersion);
        }
        int updated = query.executeUpdate();
        if (updated == 0) {
            return Optional.empty();
        }
        // Native UPDATE bypasses the persistence context; drop the stale snapshot before
        // reloading so the response and WS event carry the new text/version.
        entityManager.clear();
        return findById(workspaceId, messageId);
    }

    @Override
    public Optional<Message> softDeleteForAll(UUID workspaceId, UUID chatId, UUID messageId,
                                              Instant deletedAt, UUID deletedBy) {
        entityManager.createNativeQuery("""
                        UPDATE message.messages
                           SET deleted_at = ?1,
                               deleted_by = ?2,
                               body_ciphertext = NULL,
                               content_meta = '{}'::jsonb,
                               version = version + 1
                         WHERE id = ?3 AND workspace_id = ?4 AND chat_id = ?5
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, Timestamp.from(deletedAt))
                .setParameter(2, deletedBy)
                .setParameter(3, messageId)
                .setParameter(4, workspaceId)
                .setParameter(5, chatId)
                .executeUpdate();
        // Idempotent: an already-deleted row is still returned as the tombstone.
        entityManager.clear();
        return findById(workspaceId, messageId);
    }

    @Override
    public List<Message> findPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                                  UUID viewerId, int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.pageAscRange(workspaceId, chatId, afterSeq, beforeSeq,
                    viewerId, page);
        } else if (afterSeq != null) {
            entities = jpaRepository.pageAscAfter(workspaceId, chatId, afterSeq, viewerId, page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.pageDescBefore(workspaceId, chatId, beforeSeq, viewerId,
                    page);
        } else {
            entities = jpaRepository.pageDesc(workspaceId, chatId, viewerId, page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }

    @Override
    public List<Message> findMainPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                                      UUID viewerId, int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.mainPageAscRange(workspaceId, chatId, afterSeq, beforeSeq,
                    viewerId, page);
        } else if (afterSeq != null) {
            entities = jpaRepository.mainPageAscAfter(workspaceId, chatId, afterSeq, viewerId,
                    page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.mainPageDescBefore(workspaceId, chatId, beforeSeq, viewerId,
                    page);
        } else {
            entities = jpaRepository.mainPageDesc(workspaceId, chatId, viewerId, page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }

    @Override
    public List<Message> findThreadPage(UUID workspaceId, UUID chatId, UUID threadRootId,
                                        Long afterSeq, Long beforeSeq, UUID viewerId,
                                        int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.threadPageAscRange(workspaceId, chatId, threadRootId,
                    afterSeq, beforeSeq, viewerId, page);
        } else if (afterSeq != null) {
            entities = jpaRepository.threadPageAscAfter(workspaceId, chatId, threadRootId,
                    afterSeq, viewerId, page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.threadPageDescBefore(workspaceId, chatId, threadRootId,
                    beforeSeq, viewerId, page);
        } else {
            entities = jpaRepository.threadPageDesc(workspaceId, chatId, threadRootId, viewerId,
                    page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }

    /**
     * One windowed scan of the thread replies for the whole page of roots: the shared test
     * suite asserts the root summary is built with a single query, not per message. Only
     * live replies are counted; the excerpt is decrypted only for MANAGED rows. Replies the
     * viewer hid for themselves are not counted, matching the thread page itself.
     */
    @Override
    @SuppressWarnings("unchecked")
    public Map<UUID, ThreadSummary> findThreadSummaries(UUID workspaceId, UUID chatId,
                                                        Collection<UUID> threadRootIds,
                                                        UUID viewerId) {
        if (threadRootIds == null || threadRootIds.isEmpty()) {
            return Map.of();
        }
        Query query = entityManager.createNativeQuery("""
                SELECT t.thread_root_id,
                       t.reply_count,
                       t.last_reply_at,
                       t.sender_id,
                       t.body_ciphertext,
                       t.message_id,
                       t.crypto_scheme
                  FROM (
                        SELECT m.thread_root_id,
                               count(*) OVER (PARTITION BY m.thread_root_id) AS reply_count,
                               m.created_at AS last_reply_at,
                               m.sender_id,
                               m.body_ciphertext,
                               m.id AS message_id,
                               m.crypto_scheme,
                               row_number() OVER (PARTITION BY m.thread_root_id
                                                  ORDER BY m.seq DESC) AS rn
                          FROM message.messages m
                         WHERE m.workspace_id = :workspaceId
                           AND m.chat_id = :chatId
                           AND m.thread_root_id IN (:threadRootIds)
                           AND m.deleted_at IS NULL
                           AND NOT EXISTS (
                                 SELECT 1 FROM message.message_deletions d
                                  WHERE d.message_id = m.id
                                    AND d.user_id = :viewerId)
                       ) t
                 WHERE t.rn = 1
                """);
        query.setParameter("workspaceId", workspaceId);
        query.setParameter("chatId", chatId);
        query.setParameter("threadRootIds", threadRootIds);
        query.setParameter("viewerId", viewerId);
        List<Object[]> rows = query.getResultList();
        Map<UUID, ThreadSummary> result = new LinkedHashMap<>();
        for (Object[] row : rows) {
            UUID rootId = (UUID) row[0];
            long replyCount = ((Number) row[1]).longValue();
            Instant lastReplyAt = toInstant(row[2]);
            UUID authorId = (UUID) row[3];
            byte[] bodyCiphertext = (byte[]) row[4];
            UUID lastMessageId = (UUID) row[5];
            String cryptoScheme = (String) row[6];
            result.put(rootId, new ThreadSummary(rootId, replyCount, lastReplyAt, authorId,
                    excerpt(workspaceId, chatId, lastMessageId, cryptoScheme, bodyCiphertext)));
        }
        return result;
    }

    private String excerpt(UUID workspaceId, UUID chatId, UUID messageId, String cryptoScheme,
                           byte[] bodyCiphertext) {
        if (!"MANAGED".equals(cryptoScheme) || bodyCiphertext == null) {
            return null;
        }
        try {
            return ThreadSummary.excerpt(cipher.decrypt(bodyCiphertext,
                    MessageCipher.aad(workspaceId, chatId, messageId)));
        } catch (RuntimeException ex) {
            // A single undecryptable body must not break the whole feed; the message itself
            // will still fail loudly when it is mapped, but the root summary degrades to
            // "no preview" instead of leaking a stack trace to every reader.
            log.warn("thread.summary_excerpt_failed message_id={}", messageId);
            return null;
        }
    }

    /** PostgreSQL timestamptz through Hibernate native queries: OffsetDateTime/Timestamp. */
    private static Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof OffsetDateTime offset) {
            return offset.toInstant();
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof LocalDateTime local) {
            return local.toInstant(ZoneOffset.UTC);
        }
        throw new IllegalStateException("Unexpected timestamptz type: "
                + value.getClass().getName());
    }
}
