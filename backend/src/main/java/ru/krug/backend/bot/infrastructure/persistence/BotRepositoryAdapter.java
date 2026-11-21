package ru.krug.backend.bot.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotStatus;
import ru.krug.backend.bot.domain.repository.BotRepository;

/**
 * Native JDBC mapping for {@code bot.bots}. Native SQL keeps the PostgreSQL {@code text[]}
 * scope column and {@code bytea} token hash explicit; no token ever leaves this class except
 * as a hash. Every statement is RLS-scoped by the caller's tenant GUC.
 */
@Repository
public class BotRepositoryAdapter implements BotRepository {

    private static final String COLUMNS = """
            id, workspace_id, name, avatar_file_id, token_hash,
            array_to_string(scopes, ',') AS scopes,
            created_by, status, created_at, updated_at, token_rotated_at
            """;

    private final EntityManager entityManager;

    public BotRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
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
        return rows.stream().map(BotRepositoryAdapter::toDomain).toList();
    }

    @Override
    public void save(Bot bot) {
        entityManager.createNativeQuery("""
                        INSERT INTO bot.bots
                               (id, workspace_id, name, avatar_file_id, token_hash, scopes,
                                created_by, status, created_at, updated_at, token_rotated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, string_to_array(?6, ','),
                                ?7, ?8, ?9, ?10, ?11)
                        ON CONFLICT (id) DO UPDATE
                           SET name = EXCLUDED.name,
                               avatar_file_id = EXCLUDED.avatar_file_id,
                               token_hash = EXCLUDED.token_hash,
                               scopes = EXCLUDED.scopes,
                               status = EXCLUDED.status,
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
                .setParameter(9, Timestamp.from(bot.createdAt()))
                .setParameter(10, Timestamp.from(bot.updatedAt()))
                .setParameter(11, bot.tokenRotatedAt() == null ? null
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
        return rows.stream().findFirst().map(BotRepositoryAdapter::toDomain);
    }

    private static Bot toDomain(Object[] row) {
        String scopes = (String) row[5];
        List<String> values = scopes == null || scopes.isEmpty()
                ? List.of()
                : List.of(scopes.split(","));
        return Bot.reconstitute((UUID) row[0], (UUID) row[1], (String) row[2],
                (UUID) row[3], (byte[]) row[4], values, (UUID) row[6],
                BotStatus.valueOf((String) row[7]), instant(row[8]), instant(row[9]),
                row[10] == null ? null : instant(row[10]));
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
}
