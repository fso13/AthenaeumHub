package ru.krug.backend.bot.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotCommand;
import ru.krug.backend.bot.domain.model.BotStatus;
import ru.krug.backend.bot.domain.repository.BotRepository;

/**
 * Native JDBC mapping for {@code bot.bots}. Native SQL keeps the PostgreSQL {@code text[]}
 * scope/event columns, {@code bytea} token hash and {@code jsonb} command list explicit; no
 * raw token ever leaves this class except as a hash. Every statement is RLS-scoped by the
 * caller's tenant GUC (or by the narrow bot-event-relay worker role for the delivery picker).
 */
@Repository
public class BotRepositoryAdapter implements BotRepository {

    private static final TypeReference<List<CommandJson>> COMMANDS =
            new TypeReference<>() {
            };

    private static final String COLUMNS = """
            id, workspace_id, name, avatar_file_id, token_hash,
            array_to_string(scopes, ',') AS scopes,
            created_by, status, events_url,
            array_to_string(event_types, ',') AS event_types,
            events_enabled, signing_secret_encrypted, signing_secret_created_at,
            commands::text AS commands,
            created_at, updated_at, token_rotated_at
            """;

    private final EntityManager entityManager;
    private final ObjectMapper objectMapper;

    public BotRepositoryAdapter(EntityManager entityManager, ObjectMapper objectMapper) {
        this.entityManager = entityManager;
        this.objectMapper = objectMapper;
    }

    @Override
    public Optional<Bot> findById(UUID workspaceId, UUID botId) {
        return find(workspaceId, botId, false);
    }

    @Override
    public Optional<Bot> findByIdForUpdate(UUID workspaceId, UUID botId) {
        return find(workspaceId, botId, true);
    }

    @Override
    public List<Bot> findByWorkspace(UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("SELECT " + COLUMNS + """
                          FROM bot.bots
                         WHERE workspace_id = ?1
                         ORDER BY created_at DESC, id
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        return rows.stream().map(this::toDomain).toList();
    }

    @Override
    public void save(Bot bot) {
        entityManager.createNativeQuery("""
                        INSERT INTO bot.bots
                               (id, workspace_id, name, avatar_file_id, token_hash, scopes,
                                created_by, status, events_url, event_types, events_enabled,
                                signing_secret_encrypted, signing_secret_created_at, commands,
                                created_at, updated_at, token_rotated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, string_to_array(?6, ','),
                                ?7, ?8, ?9,
                                CASE WHEN ?10 = '' THEN ARRAY[]::text[]
                                     ELSE string_to_array(?10, ',') END,
                                ?11, ?12, ?13, CAST(?14 AS jsonb),
                                ?15, ?16, ?17)
                        ON CONFLICT (id) DO UPDATE
                           SET name = EXCLUDED.name,
                               avatar_file_id = EXCLUDED.avatar_file_id,
                               token_hash = EXCLUDED.token_hash,
                               scopes = EXCLUDED.scopes,
                               status = EXCLUDED.status,
                               events_url = EXCLUDED.events_url,
                               event_types = EXCLUDED.event_types,
                               events_enabled = EXCLUDED.events_enabled,
                               signing_secret_encrypted = EXCLUDED.signing_secret_encrypted,
                               signing_secret_created_at = EXCLUDED.signing_secret_created_at,
                               commands = EXCLUDED.commands,
                               updated_at = EXCLUDED.updated_at,
                               token_rotated_at = EXCLUDED.token_rotated_at
                        """)
                .setParameter(1, bot.id())
                .setParameter(2, bot.workspaceId())
                .setParameter(3, bot.name())
                .setParameter(4, bot.avatarFileId())
                .setParameter(5, bot.tokenHash())
                .setParameter(6, String.join(",", bot.scopes()))
                .setParameter(7, bot.createdBy())
                .setParameter(8, bot.status().name())
                .setParameter(9, bot.eventsUrl())
                .setParameter(10, String.join(",", bot.eventTypes()))
                .setParameter(11, bot.eventsEnabled())
                .setParameter(12, bot.signingSecretEncrypted())
                .setParameter(13, bot.signingSecretCreatedAt() == null ? null
                        : Timestamp.from(bot.signingSecretCreatedAt()))
                .setParameter(14, commandsJson(bot.commands()))
                .setParameter(15, Timestamp.from(bot.createdAt()))
                .setParameter(16, Timestamp.from(bot.updatedAt()))
                .setParameter(17, bot.tokenRotatedAt() == null ? null
                        : Timestamp.from(bot.tokenRotatedAt()))
                .executeUpdate();
    }

    private Optional<Bot> find(UUID workspaceId, UUID botId, boolean forUpdate) {
        if (workspaceId == null || botId == null) {
            return Optional.empty();
        }
        String sql = "SELECT " + COLUMNS + " FROM bot.bots"
                + " WHERE workspace_id = ?1 AND id = ?2"
                + (forUpdate ? " FOR UPDATE" : "");
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery(sql)
                .setParameter(1, workspaceId)
                .setParameter(2, botId)
                .getResultList();
        return rows.stream().findFirst().map(this::toDomain);
    }

    private Bot toDomain(Object[] row) {
        return Bot.reconstitute((UUID) row[0], (UUID) row[1], (String) row[2],
                (UUID) row[3], (byte[]) row[4], split(row[5]), (UUID) row[6],
                BotStatus.valueOf((String) row[7]), (String) row[8], split(row[9]),
                Boolean.TRUE.equals(row[10]), (byte[]) row[11],
                row[12] == null ? null : instant(row[12]), commands((String) row[13]),
                instant(row[14]), instant(row[15]),
                row[16] == null ? null : instant(row[16]));
    }

    private List<BotCommand> commands(String json) {
        if (json == null || json.isBlank() || "[]".equals(json.strip())) {
            return List.of();
        }
        try {
            List<CommandJson> rows = objectMapper.readValue(json, COMMANDS);
            return rows.stream()
                    .map(item -> BotCommand.of(item.command(), item.description()))
                    .toList();
        } catch (JsonProcessingException | RuntimeException ex) {
            throw new IllegalStateException("Stored bot commands are not valid JSON", ex);
        }
    }

    private String commandsJson(List<BotCommand> commands) {
        try {
            List<CommandJson> rows = commands.stream()
                    .map(item -> new CommandJson(item.command(), item.description()))
                    .toList();
            return objectMapper.writeValueAsString(rows);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Could not serialize bot commands", ex);
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
        throw new IllegalStateException("Unsupported bot timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }

    /** JSON shape only; never a domain/API type. */
    record CommandJson(String command, String description) {
    }
}
