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
    public List<Message> findPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                                  int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.pageAscRange(workspaceId, chatId, afterSeq, beforeSeq, page);
        } else if (afterSeq != null) {
            entities = jpaRepository.pageAscAfter(workspaceId, chatId, afterSeq, page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.pageDescBefore(workspaceId, chatId, beforeSeq, page);
        } else {
            entities = jpaRepository.pageDesc(workspaceId, chatId, page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }

    @Override
    public List<Message> findMainPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                                      int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.mainPageAscRange(workspaceId, chatId, afterSeq, beforeSeq,
                    page);
        } else if (afterSeq != null) {
            entities = jpaRepository.mainPageAscAfter(workspaceId, chatId, afterSeq, page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.mainPageDescBefore(workspaceId, chatId, beforeSeq, page);
        } else {
            entities = jpaRepository.mainPageDesc(workspaceId, chatId, page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }

    @Override
    public List<Message> findThreadPage(UUID workspaceId, UUID chatId, UUID threadRootId,
                                        Long afterSeq, Long beforeSeq, int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.threadPageAscRange(workspaceId, chatId, threadRootId,
                    afterSeq, beforeSeq, page);
        } else if (afterSeq != null) {
            entities = jpaRepository.threadPageAscAfter(workspaceId, chatId, threadRootId,
                    afterSeq, page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.threadPageDescBefore(workspaceId, chatId, threadRootId,
                    beforeSeq, page);
        } else {
            entities = jpaRepository.threadPageDesc(workspaceId, chatId, threadRootId, page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }

    /**
     * One windowed scan of the thread replies for the whole page of roots: the shared test
     * suite asserts the root summary is built with a single query, not per message. Only
     * live replies are counted; the excerpt is decrypted only for MANAGED rows.
     */
    @Override
    @SuppressWarnings("unchecked")
    public Map<UUID, ThreadSummary> findThreadSummaries(UUID workspaceId, UUID chatId,
                                                        Collection<UUID> threadRootIds) {
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
                       ) t
                 WHERE t.rn = 1
                """);
        query.setParameter("workspaceId", workspaceId);
        query.setParameter("chatId", chatId);
        query.setParameter("threadRootIds", threadRootIds);
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
