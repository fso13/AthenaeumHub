package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.repository.RecoveryCodeRepository;

/** Digest-only one-time recovery-code persistence. */
@Repository
public class RecoveryCodeRepositoryAdapter implements RecoveryCodeRepository {

    private final EntityManager entityManager;

    public RecoveryCodeRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void replaceAll(UUID userId, List<String> codeHashes, Instant now) {
        entityManager.createNativeQuery(
                        "DELETE FROM auth.user_recovery_codes WHERE user_id = ?1")
                .setParameter(1, userId)
                .executeUpdate();
        for (String hash : codeHashes) {
            entityManager.createNativeQuery("""
                            INSERT INTO auth.user_recovery_codes
                                   (user_id, code_hash, created_at)
                            VALUES (?1, ?2, ?3)
                            """)
                    .setParameter(1, userId)
                    .setParameter(2, hash)
                    .setParameter(3, Timestamp.from(now))
                    .executeUpdate();
        }
    }

    @Override
    public boolean consume(UUID userId, String codeHash, Instant now) {
        return entityManager.createNativeQuery("""
                        UPDATE auth.user_recovery_codes
                           SET used_at = ?3
                         WHERE user_id = ?1
                           AND code_hash = ?2
                           AND used_at IS NULL
                        """)
                .setParameter(1, userId)
                .setParameter(2, codeHash)
                .setParameter(3, Timestamp.from(now))
                .executeUpdate() > 0;
    }

    @Override
    public void deleteAll(UUID userId) {
        entityManager.createNativeQuery(
                        "DELETE FROM auth.user_recovery_codes WHERE user_id = ?1")
                .setParameter(1, userId)
                .executeUpdate();
    }

    @Override
    public long countRemaining(UUID userId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM auth.user_recovery_codes
                         WHERE user_id = ?1
                           AND used_at IS NULL
                        """)
                .setParameter(1, userId)
                .getSingleResult();
        return count.longValue();
    }
}
