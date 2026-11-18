package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.repository.DeviceRepository;

@Repository
public class DeviceRepositoryAdapter implements DeviceRepository {

    private final DeviceJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public DeviceRepositoryAdapter(DeviceJpaRepository jpaRepository,
                                   EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public void flush() {
        entityManager.flush();
    }

    @Override
    public void save(Device device) {
        DeviceEntity entity = new DeviceEntity();
        entity.setId(device.id());
        entity.setUserId(device.userId());
        entity.setName(device.name());
        entity.setPlatform(device.platform().name());
        entity.setAppVersion(device.appVersion());
        entity.setStatus(device.status().name());
        entity.setIdentityKeyAlg(device.identityKeyAlg().wireValue());
        entity.setIdentitySigningKey(device.identitySigningKey());
        entity.setIdentityDhKey(device.identityDhKey());
        entity.setIdentityBindingSignature(device.identityBindingSignature());
        entity.setFingerprint(device.fingerprint());
        entity.setKeyGeneration(device.keyGeneration());
        entity.setLastSeenAt(device.lastSeenAt());
        entity.setRevokedAt(device.revokedAt());
        if (entityManager.find(DeviceEntity.class, device.id()) == null) {
            entityManager.persist(entity);
        } else {
            entityManager.merge(entity);
        }
    }

    @Override
    public Optional<Device> findById(UUID deviceId) {
        return jpaRepository.findById(deviceId).map(DevicePersistenceMapper::toDomain);
    }

    @Override
    public long countActive(UUID userId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM auth.devices
                         WHERE user_id = ?1 AND status = 'ACTIVE'
                        """)
                .setParameter(1, userId)
                .getSingleResult();
        return count.longValue();
    }

    @Override
    public long countActiveE2eeCapable(UUID userId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM auth.devices
                         WHERE user_id = ?1
                           AND auth.device_is_e2ee_capable(status, identity_key_alg,
                                   identity_signing_key, identity_dh_key,
                                   identity_binding_signature, fingerprint)
                        """)
                .setParameter(1, userId)
                .getSingleResult();
        return count.longValue();
    }

    @Override
    public Optional<Device> findActiveByNaturalKey(UUID userId, String name, String platform,
                                                   String appVersion) {
        return entityManager.createQuery("""
                        SELECT d FROM DeviceEntity d
                         WHERE d.userId = ?1
                           AND d.name = ?2
                           AND d.platform = ?3
                           AND d.appVersion = ?4
                           AND d.status = 'ACTIVE'
                         ORDER BY d.createdAt
                        """, DeviceEntity.class)
                .setParameter(1, userId)
                .setParameter(2, name)
                .setParameter(3, platform)
                .setParameter(4, appVersion)
                .setMaxResults(1)
                .getResultList().stream().findFirst()
                .map(DevicePersistenceMapper::toDomain);
    }

    @Override
    public Optional<Device> findByPositioningIdentityKeys(UUID userId, byte[] identitySigningKey,
                                                          byte[] identityDhKey) {
        return nativeOne("""
                        SELECT * FROM auth.devices
                         WHERE user_id = CAST(?1 AS uuid)
                           AND status <> 'REVOKED'
                           AND identity_signing_key = CAST(?2 AS bytea)
                           AND identity_dh_key = CAST(?3 AS bytea)
                         ORDER BY created_at
                         LIMIT 1
                        """, userId, identitySigningKey, identityDhKey);
    }

    @Override
    public Optional<Device> findRevokedByIdentityKeys(UUID userId, byte[] identitySigningKey,
                                                      byte[] identityDhKey) {
        return nativeOne("""
                        SELECT * FROM auth.devices
                         WHERE user_id = CAST(?1 AS uuid)
                           AND status = 'REVOKED'
                           AND identity_signing_key = CAST(?2 AS bytea)
                           AND identity_dh_key = CAST(?3 AS bytea)
                         ORDER BY created_at DESC
                         LIMIT 1
                        """, userId, identitySigningKey, identityDhKey);
    }

    @Override
    public Optional<Device> findByIdentityDhKey(UUID userId, byte[] identityDhKey) {
        return nativeOne("""
                        SELECT * FROM auth.devices
                         WHERE user_id = CAST(?1 AS uuid)
                           AND status <> 'REVOKED'
                           AND identity_dh_key = CAST(?2 AS bytea)
                         ORDER BY created_at
                         LIMIT 1
                        """, userId, identityDhKey);
    }

    @Override
    public Optional<Device> findByIdentitySigningKey(UUID userId, byte[] identitySigningKey) {
        return nativeOne("""
                        SELECT * FROM auth.devices
                         WHERE user_id = CAST(?1 AS uuid)
                           AND status <> 'REVOKED'
                           AND identity_signing_key = CAST(?2 AS bytea)
                         ORDER BY created_at
                         LIMIT 1
                        """, userId, identitySigningKey);
    }

    @Override
    public List<Device> findAllByUser(UUID userId) {
        return entityManager.createQuery("""
                        SELECT d FROM DeviceEntity d
                         WHERE d.userId = ?1
                         ORDER BY d.createdAt
                        """, DeviceEntity.class)
                .setParameter(1, userId)
                .getResultList().stream()
                .map(DevicePersistenceMapper::toDomain)
                .toList();
    }

    @Override
    public List<Device> findActiveByUserIds(List<UUID> userIds) {
        if (userIds == null || userIds.isEmpty()) {
            return List.of();
        }
        return entityManager.createQuery("""
                        SELECT d FROM DeviceEntity d
                         WHERE d.userId IN ?1
                           AND d.status = 'ACTIVE'
                           AND d.identityKeyAlg = 'Ed25519+X25519'
                           AND d.identitySigningKey IS NOT NULL
                           AND d.identityDhKey IS NOT NULL
                           AND d.identityBindingSignature IS NOT NULL
                           AND d.fingerprint IS NOT NULL
                         ORDER BY d.userId, d.createdAt
                        """, DeviceEntity.class)
                .setParameter(1, userIds)
                .getResultList().stream()
                .map(DevicePersistenceMapper::toDomain)
                .toList();
    }

    @Override
    public boolean isActiveDeviceOfUser(UUID deviceId, UUID userId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM auth.devices
                         WHERE id = ?1 AND user_id = ?2 AND status = 'ACTIVE'
                        """)
                .setParameter(1, deviceId)
                .setParameter(2, userId)
                .getSingleResult();
        return count.longValue() > 0;
    }

    @Override
    public void lockOwner(UUID userId) {
        entityManager.createNativeQuery("""
                        SELECT id FROM auth.users WHERE id = ?1 FOR UPDATE
                        """)
                .setParameter(1, userId)
                .getSingleResult();
    }

    @Override
    public void touchLastSeen(UUID deviceId, Instant at) {
        entityManager.createNativeQuery("""
                        UPDATE auth.devices SET last_seen_at = ?2 WHERE id = ?1
                        """)
                .setParameter(1, deviceId)
                .setParameter(2, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public void revoke(UUID deviceId, Instant at) {
        entityManager.createNativeQuery("""
                        UPDATE auth.devices
                           SET status = 'REVOKED',
                               key_generation = LEAST(key_generation + 1, 2147483647),
                               revoked_at = ?2,
                               revoked_reason = 'USER_REVOKED'
                         WHERE id = ?1 AND status <> 'REVOKED'
                        """)
                .setParameter(1, deviceId)
                .setParameter(2, Timestamp.from(at))
                .executeUpdate();
    }

    private Optional<Device> nativeOne(String sql, UUID userId, byte[] first, byte[] second) {
        return entityManager.createNativeQuery(sql, DeviceEntity.class)
                .setParameter(1, userId)
                .setParameter(2, first)
                .setParameter(3, second)
                .getResultList().stream().findFirst()
                .map(entity -> DevicePersistenceMapper.toDomain((DeviceEntity) entity));
    }

    private Optional<Device> nativeOne(String sql, UUID userId, byte[] first) {
        return entityManager.createNativeQuery(sql, DeviceEntity.class)
                .setParameter(1, userId)
                .setParameter(2, first)
                .getResultList().stream().findFirst()
                .map(entity -> DevicePersistenceMapper.toDomain((DeviceEntity) entity));
    }

    private Optional<Device> nativeOne(String sql, byte[] first) {
        return entityManager.createNativeQuery(sql, DeviceEntity.class)
                .setParameter(1, first)
                .getResultList().stream().findFirst()
                .map(entity -> DevicePersistenceMapper.toDomain((DeviceEntity) entity));
    }
}
