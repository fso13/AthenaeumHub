package ru.krug.backend.bot.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.bot.domain.model.BotCommandToken;
import ru.krug.backend.bot.domain.repository.BotCommandTokenRepository;

/** Native JDBC mapping for {@code bot.command_tokens}; only the SHA-256 hash is stored. */
@Repository
public class BotCommandTokenRepositoryAdapter implements BotCommandTokenRepository {

    private final EntityManager entityManager;

    public BotCommandTokenRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void save(BotCommandToken token) {
        entityManager.createNativeQuery("""
                        INSERT INTO bot.command_tokens
                               (id, workspace_id, chat_id, bot_id, invoked_by, command,
                                token_hash, expires_at, consumed_at, response_message_id,
                                created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                        """)
                .setParameter(1, token.id())
                .setParameter(2, token.workspaceId())
                .setParameter(3, token.chatId())
                .setParameter(4, token.botId())
                .setParameter(5, token.invokedBy())
                .setParameter(6, token.command())
                .setParameter(7, token.tokenHash())
                .setParameter(8, Timestamp.from(token.expiresAt()))
                .setParameter(9, token.consumedAt() == null ? null
                        : Timestamp.from(token.consumedAt()))
                .setParameter(10, token.responseMessageId())
                .setParameter(11, Timestamp.from(token.createdAt()))
                .executeUpdate();
    }

    @Override
    public Optional<BotCommandToken> findById(UUID workspaceId, UUID tokenId) {
        if (workspaceId == null || tokenId == null) {
            return Optional.empty();
        }
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, chat_id, bot_id, invoked_by, command,
                               token_hash, expires_at, consumed_at, response_message_id,
                               created_at
                          FROM bot.command_tokens
                         WHERE workspace_id = ?1 AND id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, tokenId)
                .getResultList();
        return rows.stream().findFirst().map(BotCommandTokenRepositoryAdapter::toDomain);
    }

    @Override
    public boolean consume(UUID workspaceId, UUID tokenId, Instant now) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE bot.command_tokens
                           SET consumed_at = ?3
                         WHERE workspace_id = ?1 AND id = ?2
                           AND consumed_at IS NULL AND expires_at > ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, tokenId)
                .setParameter(3, Timestamp.from(now))
                .executeUpdate();
        return updated == 1;
    }

    @Override
    public void attachResponseMessage(UUID workspaceId, UUID tokenId, UUID messageId) {
        entityManager.createNativeQuery("""
                        UPDATE bot.command_tokens
                           SET response_message_id = ?3
                         WHERE workspace_id = ?1 AND id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, tokenId)
                .setParameter(3, messageId)
                .executeUpdate();
    }

    private static BotCommandToken toDomain(Object[] row) {
        return new BotCommandToken((UUID) row[0], (UUID) row[1], (UUID) row[2],
                (UUID) row[3], (UUID) row[4], (String) row[5], (byte[]) row[6],
                instant(row[7]), row[8] == null ? null : instant(row[8]), (UUID) row[9],
                instant(row[10]));
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
        throw new IllegalStateException("Unsupported command-token timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }
}
