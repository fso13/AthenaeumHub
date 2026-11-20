package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.TwoFactorSettings;
import ru.krug.backend.auth.domain.repository.TwoFactorRepository;

/** Native-SQL authenticator persistence; the secret is AES-GCM encrypted by the adapter. */
@Repository
public class TwoFactorRepositoryAdapter implements TwoFactorRepository {

    private final EntityManager entityManager;
    private final TotpSecretCipher cipher;

    public TwoFactorRepositoryAdapter(EntityManager entityManager, TotpSecretCipher cipher) {
        this.entityManager = entityManager;
        this.cipher = cipher;
    }

    @Override
    public Optional<TwoFactorSettings> find(UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT user_id, secret_ciphertext, enabled_at, last_used_step,
                               created_at, updated_at
                          FROM auth.user_totp
                         WHERE user_id = ?1
                        """)
                .setParameter(1, userId)
                .getResultList();
        return rows.stream().findFirst().map(row -> TwoFactorSettings.reconstitute(
                (UUID) row[0],
                cipher.decrypt((byte[]) row[1], (UUID) row[0]),
                instant(row[2]),
                ((Number) row[3]).longValue(),
                instant(row[4]),
                instant(row[5])));
    }

    @Override
    public void savePending(UUID userId, String secret, Instant now) {
        entityManager.createNativeQuery("""
                        INSERT INTO auth.user_totp
                               (user_id, secret_ciphertext, enabled_at, last_used_step,
                                created_at, updated_at)
                        VALUES (?1, ?2, NULL, 0, ?3, ?3)
                        ON CONFLICT (user_id) DO UPDATE
                           SET secret_ciphertext = EXCLUDED.secret_ciphertext,
                               last_used_step = 0,
                               enabled_at = NULL,
                               updated_at = EXCLUDED.updated_at
                        """)
                .setParameter(1, userId)
                .setParameter(2, cipher.encrypt(secret, userId))
                .setParameter(3, Timestamp.from(now))
                .executeUpdate();
    }

    @Override
    public void enable(UUID userId, Instant now) {
        entityManager.createNativeQuery("""
                        UPDATE auth.user_totp
                           SET enabled_at = ?2,
                               updated_at = ?2
                         WHERE user_id = ?1
                        """)
                .setParameter(1, userId)
                .setParameter(2, Timestamp.from(now))
                .executeUpdate();
    }

    @Override
    public void updateLastUsedStep(UUID userId, long step, Instant now) {
        entityManager.createNativeQuery("""
                        UPDATE auth.user_totp
                           SET last_used_step = ?2,
                               updated_at = ?3
                         WHERE user_id = ?1
                           AND last_used_step < ?2
                        """)
                .setParameter(1, userId)
                .setParameter(2, step)
                .setParameter(3, Timestamp.from(now))
                .executeUpdate();
    }

    @Override
    public void delete(UUID userId) {
        entityManager.createNativeQuery("DELETE FROM auth.user_totp WHERE user_id = ?1")
                .setParameter(1, userId)
                .executeUpdate();
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
        if (value instanceof java.time.OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value.getClass());
    }
}
