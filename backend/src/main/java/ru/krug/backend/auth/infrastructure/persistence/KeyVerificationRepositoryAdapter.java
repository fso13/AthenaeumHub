package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.KeyVerification;
import ru.krug.backend.auth.domain.repository.KeyVerificationRepository;

@Repository
public class KeyVerificationRepositoryAdapter implements KeyVerificationRepository {

    private final EntityManager entityManager;

    public KeyVerificationRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void upsert(KeyVerification verification) {
        entityManager.createNativeQuery("""
                        INSERT INTO auth.key_verifications
                               (id, workspace_id, chat_id, verifier_user_id, verifier_device_id,
                                target_device_id, target_key_generation, method, vh_version,
                                safety_number_hash, verified_at, revoked_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                                CAST(?10 AS bytea), CAST(?11 AS timestamptz), NULL)
                        ON CONFLICT (verifier_device_id, target_device_id, chat_id) DO UPDATE
                           SET target_key_generation = EXCLUDED.target_key_generation,
                               method = EXCLUDED.method,
                               vh_version = EXCLUDED.vh_version,
                               safety_number_hash = EXCLUDED.safety_number_hash,
                               verified_at = EXCLUDED.verified_at,
                               revoked_at = NULL
                        """)
                .setParameter(1, verification.id())
                .setParameter(2, verification.workspaceId())
                .setParameter(3, verification.chatId())
                .setParameter(4, verification.verifierUserId())
                .setParameter(5, verification.verifierDeviceId())
                .setParameter(6, verification.targetDeviceId())
                .setParameter(7, verification.targetKeyGeneration())
                .setParameter(8, verification.method().name())
                .setParameter(9, verification.vhVersion())
                .setParameter(10, verification.safetyNumberHash())
                .setParameter(11, Timestamp.from(verification.verifiedAt()))
                .executeUpdate();
    }

    @Override
    public List<KeyVerification> findByVerifierAndChat(UUID verifierDeviceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, chat_id, verifier_user_id, verifier_device_id,
                               target_device_id, target_key_generation, method, vh_version,
                               safety_number_hash, verified_at, revoked_at
                          FROM auth.key_verifications
                         WHERE verifier_device_id = ?1
                           AND chat_id = ?2
                           AND revoked_at IS NULL
                        """)
                .setParameter(1, verifierDeviceId)
                .setParameter(2, chatId)
                .getResultList();
        return rows.stream().map(KeyVerificationRepositoryAdapter::toDomain).toList();
    }

    private static KeyVerification toDomain(Object[] row) {
        return new KeyVerification((UUID) row[0], (UUID) row[1], (UUID) row[2], (UUID) row[3],
                (UUID) row[4], (UUID) row[5], ((Number) row[6]).intValue(),
                KeyVerification.Method.valueOf((String) row[7]), ((Number) row[8]).intValue(),
                (byte[]) row[9], DevicePrekeyRepositoryAdapter.instant(row[10]),
                DevicePrekeyRepositoryAdapter.instant(row[11]));
    }

    @Override
    public java.util.Optional<KeyVerification> findById(UUID verificationId) {
        @SuppressWarnings("unchecked")
        java.util.List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, chat_id, verifier_user_id, verifier_device_id,
                               target_device_id, target_key_generation, method, vh_version,
                               safety_number_hash, verified_at, revoked_at
                          FROM auth.key_verifications
                         WHERE id = ?1
                        """)
                .setParameter(1, verificationId)
                .getResultList();
        return rows.stream().findFirst().map(KeyVerificationRepositoryAdapter::toDomain);
    }

    @Override
    public int countByOtherVerifierDevices(UUID workspaceId, UUID chatId, UUID verifierUserId,
                                           UUID verifierDeviceId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(DISTINCT target_device_id)
                          FROM auth.key_verifications
                         WHERE workspace_id = ?1
                           AND chat_id = ?2
                           AND verifier_user_id = ?3
                           AND verifier_device_id <> ?4
                           AND revoked_at IS NULL
                           AND target_key_generation = (
                               SELECT d.key_generation FROM auth.devices d
                                WHERE d.id = auth.key_verifications.target_device_id)
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, verifierUserId)
                .setParameter(4, verifierDeviceId)
                .getSingleResult();
        return count.intValue();
    }

    @Override
    public void revokeForTargetDevice(UUID targetDeviceId, Instant at) {
        entityManager.createNativeQuery("""
                        UPDATE auth.key_verifications
                           SET revoked_at = ?2
                         WHERE target_device_id = ?1 AND revoked_at IS NULL
                        """)
                .setParameter(1, targetDeviceId)
                .setParameter(2, Timestamp.from(at))
                .executeUpdate();
    }
}
