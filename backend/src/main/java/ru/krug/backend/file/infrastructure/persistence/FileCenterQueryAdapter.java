package ru.krug.backend.file.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Repository;

import ru.krug.backend.file.application.model.FileCenterRow;
import ru.krug.backend.file.application.port.FileCenterQueryPort;
import ru.krug.backend.file.domain.model.MediaMetadata;

/**
 * Native SQL file-center query. The joins enforce visibility in the database, in one round
 * trip:
 * <ul>
 *   <li>{@code chat_members} — the caller must be an ACTIVE member of the attachment's chat;</li>
 *   <li>{@code chats.security_mode = 'MANAGED'} — E2EE chats never surface here;</li>
 *   <li>{@code EXISTS message} with {@code crypto_scheme = 'MANAGED'} and
 *       {@code deleted_at IS NULL} — E2EE or delete-for-all messages never surface;</li>
 *   <li>{@code message_deletions} — delete-for-me hides the file for that caller only.</li>
 * </ul>
 *
 * <p>RLS still applies to every joined table; the caller has already activated the tenant
 * context. Only metadata columns are selected — no object key, hash, bytes or URL.
 */
@Repository
public class FileCenterQueryAdapter implements FileCenterQueryPort {

    private static final String BASE_SQL = """
            SELECT a.id, a.chat_id, c.name AS chat_name, a.message_id, a.filename,
                   a.mime_type, a.size_bytes, a.scan_status, a.created_at,
                   CAST(a.media AS text) AS media_json
              FROM file.attachments a
              JOIN chat.chats c
                ON c.id = a.chat_id AND c.workspace_id = a.workspace_id
              JOIN chat.chat_members cm
                ON cm.chat_id = a.chat_id AND cm.workspace_id = a.workspace_id
               AND cm.user_id = :userId AND cm.status = 'ACTIVE'
             WHERE a.workspace_id = :workspaceId
               AND a.message_id IS NOT NULL
               AND a.status IN ('READY', 'BOUND', 'QUARANTINED')
               AND c.deleted_at IS NULL
               AND c.security_mode = 'MANAGED'
               AND EXISTS (
                     SELECT 1 FROM message.messages m
                      WHERE m.id = a.message_id
                        AND m.workspace_id = a.workspace_id
                        AND m.chat_id = a.chat_id
                        AND m.deleted_at IS NULL
                        AND m.crypto_scheme = 'MANAGED'
                   )
               AND NOT EXISTS (
                     SELECT 1 FROM message.message_deletions d
                      WHERE d.message_id = a.message_id AND d.user_id = :userId
                   )
            """;

    private final EntityManager entityManager;
    private final ObjectMapper objectMapper;

    public FileCenterQueryAdapter(EntityManager entityManager, ObjectMapper objectMapper) {
        this.entityManager = entityManager;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<FileCenterRow> findPage(FileCenterQuery query) {
        StringBuilder sql = new StringBuilder(BASE_SQL);
        if (query.chatId() != null) {
            sql.append(" AND a.chat_id = :chatId");
        }
        if (query.kind() != null) {
            sql.append("""
                     AND COALESCE(
                           a.media->>'kind',
                           CASE WHEN lower(a.mime_type) LIKE 'image/%' THEN 'IMAGE'
                                WHEN lower(a.mime_type) LIKE 'audio/%' THEN 'AUDIO'
                                WHEN lower(a.mime_type) LIKE 'video/%' THEN 'VIDEO'
                                ELSE 'FILE' END
                         ) = :kind
                    """);
        }
        if (query.scanStatus() != null) {
            sql.append(" AND a.scan_status = :scanStatus");
        }
        if (query.search() != null) {
            sql.append("""
                     AND (
                           position(lower(:search) in lower(a.filename)) > 0
                           OR position(lower(:search) in lower(coalesce(a.mime_type, ''))) > 0
                         )
                    """);
        }
        if (query.mime() != null) {
            sql.append(" AND lower(a.mime_type) = :mime");
        }
        if (query.extension() != null) {
            sql.append(" AND lower(a.filename) LIKE ('%.' || :extension)");
        }
        if (query.cursorCreatedAt() != null && query.cursorId() != null) {
            sql.append(" AND (a.created_at, a.id) < (:cursorAt, :cursorId)");
        }
        sql.append(" ORDER BY a.created_at DESC, a.id DESC LIMIT :fetchLimit");

        Query nativeQuery = entityManager.createNativeQuery(sql.toString());
        nativeQuery.setParameter("workspaceId", query.workspaceId());
        nativeQuery.setParameter("userId", query.userId());
        nativeQuery.setParameter("fetchLimit", query.fetchLimit());
        if (query.chatId() != null) {
            nativeQuery.setParameter("chatId", query.chatId());
        }
        if (query.kind() != null) {
            nativeQuery.setParameter("kind", query.kind());
        }
        if (query.scanStatus() != null) {
            nativeQuery.setParameter("scanStatus", query.scanStatus());
        }
        if (query.search() != null) {
            nativeQuery.setParameter("search", query.search());
        }
        if (query.mime() != null) {
            nativeQuery.setParameter("mime", query.mime());
        }
        if (query.extension() != null) {
            nativeQuery.setParameter("extension", query.extension());
        }
        if (query.cursorCreatedAt() != null && query.cursorId() != null) {
            nativeQuery.setParameter("cursorAt", Timestamp.from(query.cursorCreatedAt()));
            nativeQuery.setParameter("cursorId", query.cursorId());
        }

        @SuppressWarnings("unchecked")
        List<Object[]> rows = nativeQuery.getResultList();
        return rows.stream().map(this::toRow).toList();
    }

    private FileCenterRow toRow(Object[] row) {
        return new FileCenterRow(uuid(row[0]), uuid(row[1]), (String) row[2], uuid(row[3]),
                (String) row[4], (String) row[5], media(row[9]),
                ((Number) row[6]).longValue(), (String) row[7], instant(row[8]));
    }

    private MediaMetadata media(Object json) {
        if (json == null) {
            return null;
        }
        try {
            Map<String, Object> map = objectMapper.readValue(json.toString(),
                    new TypeReference<Map<String, Object>>() { });
            return MediaMetadata.fromMap(map);
        } catch (RuntimeException | java.io.IOException ex) {
            // Fail-closed: malformed metadata must never break the file list.
            return null;
        }
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
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        if (value instanceof LocalDateTime localDateTime) {
            return localDateTime.toInstant(ZoneOffset.UTC);
        }
        throw new IllegalStateException("Unsupported timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }
}
