package ru.krug.backend.bot.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.bot.domain.model.BotCommand;
import ru.krug.backend.bot.domain.model.BotDeliveryStatus;
import ru.krug.backend.bot.domain.model.BotEventDelivery;
import ru.krug.backend.bot.domain.model.BotEventTarget;
import ru.krug.backend.bot.domain.model.BotEventType;
import ru.krug.backend.bot.domain.repository.BotEventRepository;

/** Native JDBC mapping for the bot event outbox and the installed-bot target projection. */
@Repository
public class BotEventRepositoryAdapter implements BotEventRepository {

    private static final TypeReference<List<CommandJson>> COMMANDS = new TypeReference<>() {
    };

    private final EntityManager entityManager;
    private final ObjectMapper objectMapper;

    public BotEventRepositoryAdapter(EntityManager entityManager, ObjectMapper objectMapper) {
        this.entityManager = entityManager;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<BotEventTarget> findTargets(UUID workspaceId, UUID chatId) {
        if (workspaceId == null || chatId == null) {
            return List.of();
        }
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT b.id, b.name, b.events_url,
                               array_to_string(b.event_types, ',') AS event_types,
                               b.events_enabled,
                               (b.signing_secret_encrypted IS NOT NULL) AS has_secret,
                               b.commands::text AS commands
                          FROM bot.bots b
                          JOIN bot.chat_bots cb
                            ON cb.bot_id = b.id
                           AND cb.workspace_id = b.workspace_id
                         WHERE b.workspace_id = ?1
                           AND cb.chat_id = ?2
                           AND cb.enabled
                           AND b.status = 'ACTIVE'
                         ORDER BY b.created_at, b.id
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .getResultList();
        return rows.stream().map(this::toTarget).toList();
    }

    @Override
    public boolean enqueue(BotEventDelivery delivery) {
        int inserted = entityManager.createNativeQuery("""
                        INSERT INTO bot.event_deliveries
                               (id, workspace_id, bot_id, chat_id, event_type, event_id,
                                payload_encrypted, status, attempt_count, next_attempt_at,
                                created_at, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                        ON CONFLICT (bot_id, event_type, event_id) DO NOTHING
                        """)
                .setParameter(1, delivery.id())
                .setParameter(2, delivery.workspaceId())
                .setParameter(3, delivery.botId())
                .setParameter(4, delivery.chatId())
                .setParameter(5, delivery.eventType().wire())
                .setParameter(6, delivery.eventId())
                .setParameter(7, delivery.payloadEncrypted())
                .setParameter(8, delivery.status().name())
                .setParameter(9, delivery.attemptCount())
                .setParameter(10, Timestamp.from(delivery.nextAttemptAt()))
                .setParameter(11, Timestamp.from(delivery.createdAt()))
                .setParameter(12, Timestamp.from(delivery.updatedAt()))
                .executeUpdate();
        return inserted == 1;
    }

    @Override
    public List<BotEventDelivery> findRecent(UUID workspaceId, UUID botId, int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, bot_id, chat_id, event_type, event_id,
                               status, attempt_count, next_attempt_at, last_status_code,
                               last_error, created_at, updated_at, delivered_at
                          FROM bot.event_deliveries
                         WHERE workspace_id = ?1 AND bot_id = ?2
                         ORDER BY created_at DESC, id DESC
                         LIMIT ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, botId)
                .setParameter(3, limit)
                .getResultList();
        return rows.stream().map(this::toDelivery).toList();
    }

    @Override
    public List<BotEventDelivery> lockDue(Instant now, int batchSize) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, bot_id, chat_id, event_type, event_id,
                               payload_encrypted, status, attempt_count, next_attempt_at,
                               last_status_code, last_error, created_at, updated_at,
                               delivered_at
                          FROM bot.event_deliveries
                         WHERE status = 'PENDING'
                           AND next_attempt_at <= ?1
                         ORDER BY next_attempt_at, id
                         FOR UPDATE SKIP LOCKED
                         LIMIT ?2
                        """)
                .setParameter(1, Timestamp.from(now))
                .setParameter(2, batchSize)
                .getResultList();
        return rows.stream().map(this::toDeliveryWithPayload).toList();
    }

    @Override
    public void markDelivered(UUID id, Instant now) {
        entityManager.createNativeQuery("""
                        UPDATE bot.event_deliveries
                           SET status = 'DELIVERED', delivered_at = ?2, updated_at = ?2,
                               last_error = NULL, last_status_code = NULL
                         WHERE id = ?1
                        """)
                .setParameter(1, id)
                .setParameter(2, Timestamp.from(now))
                .executeUpdate();
    }

    @Override
    public void markFailed(UUID id, int attempts, Integer statusCode, String error,
                           Instant now) {
        entityManager.createNativeQuery("""
                        UPDATE bot.event_deliveries
                           SET status = 'FAILED', attempt_count = ?2, last_status_code = ?3,
                               last_error = ?4, updated_at = ?5, next_attempt_at = ?5
                         WHERE id = ?1
                        """)
                .setParameter(1, id)
                .setParameter(2, attempts)
                .setParameter(3, statusCode)
                .setParameter(4, error)
                .setParameter(5, Timestamp.from(now))
                .executeUpdate();
    }

    @Override
    public void reschedule(UUID id, int attempts, Instant nextAttemptAt, Integer statusCode,
                           String error, Instant now) {
        entityManager.createNativeQuery("""
                        UPDATE bot.event_deliveries
                           SET status = 'PENDING', attempt_count = ?2, next_attempt_at = ?3,
                               last_status_code = ?4, last_error = ?5, updated_at = ?6
                         WHERE id = ?1
                        """)
                .setParameter(1, id)
                .setParameter(2, attempts)
                .setParameter(3, Timestamp.from(nextAttemptAt))
                .setParameter(4, statusCode)
                .setParameter(5, error)
                .setParameter(6, Timestamp.from(now))
                .executeUpdate();
    }

    private BotEventTarget toTarget(Object[] row) {
        return new BotEventTarget((UUID) row[0], (String) row[1], (String) row[2],
                split(row[3]), Boolean.TRUE.equals(row[4]), Boolean.TRUE.equals(row[5]),
                commands((String) row[6]));
    }

    private BotEventDelivery toDelivery(Object[] row) {
        return new BotEventDelivery((UUID) row[0], (UUID) row[1], (UUID) row[2],
                (UUID) row[3], BotEventType.fromWire((String) row[4]), (UUID) row[5], null,
                BotDeliveryStatus.valueOf((String) row[6]), ((Number) row[7]).intValue(),
                instant(row[8]), row[9] == null ? null : ((Number) row[9]).intValue(),
                (String) row[10], instant(row[11]), instant(row[12]),
                row[13] == null ? null : instant(row[13]));
    }

    private BotEventDelivery toDeliveryWithPayload(Object[] row) {
        return new BotEventDelivery((UUID) row[0], (UUID) row[1], (UUID) row[2],
                (UUID) row[3], BotEventType.fromWire((String) row[4]), (UUID) row[5],
                (byte[]) row[6], BotDeliveryStatus.valueOf((String) row[7]),
                ((Number) row[8]).intValue(), instant(row[9]),
                row[10] == null ? null : ((Number) row[10]).intValue(),
                (String) row[11], instant(row[12]), instant(row[13]),
                row[14] == null ? null : instant(row[14]));
    }

    private List<BotCommand> commands(String json) {
        if (json == null || json.isBlank() || "[]".equals(json.strip())) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, COMMANDS).stream()
                    .map(item -> BotCommand.of(item.command(), item.description()))
                    .toList();
        } catch (JsonProcessingException | RuntimeException ex) {
            throw new IllegalStateException("Stored bot commands are not valid JSON", ex);
        }
    }

    private static List<String> split(Object value) {
        String joined = (String) value;
        if (joined == null || joined.isBlank()) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (String item : joined.split(",")) {
            if (!item.isBlank()) {
                result.add(item);
            }
        }
        return List.copyOf(result);
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
        throw new IllegalStateException("Unsupported bot delivery timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }

    record CommandJson(String command, String description) {
    }
}
