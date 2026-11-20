package ru.krug.backend.message.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Repository;

import ru.krug.backend.message.application.model.MessageSearchCriteria;
import ru.krug.backend.message.application.model.MessageSearchRow;
import ru.krug.backend.message.application.port.MessageSearchPort;

/**
 * Native SQL candidate query for server-side message search (#83).
 *
 * <p>Managed bodies are AES-GCM at rest, so the database cannot do a {@code LIKE}. This
 * query therefore selects a bounded keyset window of <b>candidates</b> and decrypts each
 * ciphertext in-process; the service applies the literal match and snippet. The security
 * invariants are enforced in the same SQL statement, not by post-filtering:
 *
 * <ul>
 *   <li>{@code chat_members.status = 'ACTIVE'} for the caller in every chat — a workspace
 *       member cannot search a private chat they are not in;</li>
 *   <li>{@code chats.security_mode = 'MANAGED'} and
 *       {@code messages.crypto_scheme = 'MANAGED'} — E2EE ciphertext never reaches the
 *       application layer;</li>
 *   <li>{@code chats.deleted_at IS NULL} and {@code messages.deleted_at IS NULL};</li>
 *   <li>no {@code message.message_deletions} row for the caller (delete-for-me);</li>
 *   <li>only {@code TEXT} rows with a body.</li>
 * </ul>
 *
 * <p>RLS applies to every table; the caller has activated the tenant context. Only the body
 * ciphertext and display metadata are selected — no envelope, key, attachment or reaction
 * data.
 */
@Repository
public class MessageSearchQueryAdapter implements MessageSearchPort {

    private static final Logger log = LoggerFactory.getLogger(MessageSearchQueryAdapter.class);

    private static final String BASE_SQL = """
            SELECT m.id, m.chat_id, c.name AS chat_name, m.seq, m.sender_id,
                   m.sender_display_name, m.body_ciphertext, m.created_at, m.workspace_id
              FROM message.messages m
              JOIN chat.chats c
                ON c.id = m.chat_id AND c.workspace_id = m.workspace_id
              JOIN chat.chat_members cm
                ON cm.chat_id = m.chat_id AND cm.workspace_id = m.workspace_id
               AND cm.user_id = :userId AND cm.status = 'ACTIVE'
             WHERE m.workspace_id = :workspaceId
               AND m.type = 'TEXT'
               AND m.crypto_scheme = 'MANAGED'
               AND m.body_ciphertext IS NOT NULL
               AND m.deleted_at IS NULL
               AND c.deleted_at IS NULL
               AND c.security_mode = 'MANAGED'
               AND NOT EXISTS (
                     SELECT 1 FROM message.message_deletions d
                      WHERE d.message_id = m.id AND d.user_id = :userId
                   )
            """;

    private final EntityManager entityManager;
    private final MessageCipher cipher;

    public MessageSearchQueryAdapter(EntityManager entityManager, MessageCipher cipher) {
        this.entityManager = entityManager;
        this.cipher = cipher;
    }

    @Override
    public List<MessageSearchRow> findCandidates(MessageSearchCriteria criteria) {
        StringBuilder sql = new StringBuilder(BASE_SQL);
        if (criteria.chatId() != null) {
            sql.append(" AND m.chat_id = :chatId");
        }
        if (criteria.from() != null) {
            sql.append(" AND m.created_at >= :from");
        }
        if (criteria.to() != null) {
            sql.append(" AND m.created_at < :to");
        }
        if (criteria.cursorCreatedAt() != null && criteria.cursorId() != null) {
            sql.append(" AND (m.created_at, m.id) < (:cursorAt, :cursorId)");
        }
        sql.append(" ORDER BY m.created_at DESC, m.id DESC LIMIT :fetchLimit");

        Query query = entityManager.createNativeQuery(sql.toString());
        query.setParameter("workspaceId", criteria.workspaceId());
        query.setParameter("userId", criteria.userId());
        query.setParameter("fetchLimit", criteria.fetchLimit());
        if (criteria.chatId() != null) {
            query.setParameter("chatId", criteria.chatId());
        }
        if (criteria.from() != null) {
            query.setParameter("from", Timestamp.from(criteria.from()));
        }
        if (criteria.to() != null) {
            query.setParameter("to", Timestamp.from(criteria.to()));
        }
        if (criteria.cursorCreatedAt() != null && criteria.cursorId() != null) {
            query.setParameter("cursorAt", Timestamp.from(criteria.cursorCreatedAt()));
            query.setParameter("cursorId", criteria.cursorId());
        }

        @SuppressWarnings("unchecked")
        List<Object[]> rows = query.getResultList();
        List<MessageSearchRow> candidates = new ArrayList<>(rows.size());
        for (Object[] row : rows) {
            UUID messageId = uuid(row[0]);
            UUID chatId = uuid(row[1]);
            UUID workspaceId = uuid(row[8]);
            byte[] ciphertext = (byte[]) row[6];
            String text;
            try {
                text = cipher.decrypt(ciphertext, MessageCipher.aad(workspaceId, chatId,
                        messageId));
            } catch (RuntimeException ex) {
                // Fail closed: a body that cannot be authenticated is never searched or
                // echoed. The row is skipped, not surfaced as an empty hit.
                log.warn("message.search.decrypt_failed message_id={}", messageId);
                continue;
            }
            if (text == null || text.isEmpty()) {
                continue;
            }
            candidates.add(new MessageSearchRow(messageId, chatId, (String) row[2],
                    ((Number) row[3]).longValue(), uuid(row[4]), (String) row[5], text,
                    instant(row[7])));
        }
        return candidates;
    }

    private static UUID uuid(Object value) {
        if (value == null) {
            return null;
        }
        return value instanceof UUID uuid ? uuid : UUID.fromString(value.toString());
    }

    private static Instant instant(Object value) {
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }
}
