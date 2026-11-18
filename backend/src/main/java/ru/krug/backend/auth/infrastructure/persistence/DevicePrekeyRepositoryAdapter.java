package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.DevicePrekey;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;

@Repository
public class DevicePrekeyRepositoryAdapter implements DevicePrekeyRepository {

    private final EntityManager entityManager;

    public DevicePrekeyRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void save(DevicePrekey prekey) {
        // Signature is NULL for one-time prekeys; a NULL literal keeps the native query
        // free of Hibernate type inference for a null bytea parameter.
        if (prekey.kind() == DevicePrekey.Kind.SIGNED) {
            entityManager.createNativeQuery("""
                            INSERT INTO auth.device_prekeys
                                   (device_id, key_id, kind, public_key, signature, created_at,
                                    expires_at, retired_at, consumed_at)
                            VALUES (?1, ?2, 'SIGNED', CAST(?3 AS bytea), CAST(?4 AS bytea),
                                    CAST(?5 AS timestamptz), CAST(?6 AS timestamptz), NULL, NULL)
                            """)
                    .setParameter(1, prekey.deviceId())
                    .setParameter(2, prekey.keyId())
                    .setParameter(3, prekey.publicKey())
                    .setParameter(4, prekey.signature())
                    .setParameter(5, Timestamp.from(prekey.createdAt()))
                    .setParameter(6, Timestamp.from(prekey.expiresAt()))
                    .executeUpdate();
        } else {
            entityManager.createNativeQuery("""
                            INSERT INTO auth.device_prekeys
                                   (device_id, key_id, kind, public_key, signature, created_at,
                                    expires_at, retired_at, consumed_at)
                            VALUES (?1, ?2, 'ONE_TIME', CAST(?3 AS bytea), NULL,
                                    CAST(?4 AS timestamptz), CAST(?5 AS timestamptz), NULL, NULL)
                            """)
                    .setParameter(1, prekey.deviceId())
                    .setParameter(2, prekey.keyId())
                    .setParameter(3, prekey.publicKey())
                    .setParameter(4, Timestamp.from(prekey.createdAt()))
                    .setParameter(5, Timestamp.from(prekey.expiresAt()))
                    .executeUpdate();
        }
    }

    @Override
    public Optional<DevicePrekey> find(UUID deviceId, String keyId) {
        return rows("""
                        SELECT device_id, key_id, kind, public_key, signature, created_at,
                               expires_at, retired_at, consumed_at
                          FROM auth.device_prekeys
                         WHERE device_id = ?1 AND key_id = ?2
                        """, deviceId, keyId).stream().findFirst();
    }

    @Override
    public List<DevicePrekey> findAll(UUID deviceId) {
        return rows("""
                        SELECT device_id, key_id, kind, public_key, signature, created_at,
                               expires_at, retired_at, consumed_at
                          FROM auth.device_prekeys
                         WHERE device_id = ?1
                         ORDER BY kind, created_at
                        """, deviceId);
    }

    @Override
    public Optional<DevicePrekey> findActiveSigned(UUID deviceId, Instant now) {
        return rows("""
                        SELECT device_id, key_id, kind, public_key, signature, created_at,
                               expires_at, retired_at, consumed_at
                          FROM auth.device_prekeys
                         WHERE device_id = ?1
                           AND kind = 'SIGNED'
                           AND retired_at IS NULL
                           AND expires_at > ?2
                         ORDER BY created_at DESC
                         LIMIT 1
                        """, deviceId, Timestamp.from(now)).stream().findFirst();
    }

    @Override
    public int countAvailableOneTime(UUID deviceId, Instant now) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*) FROM auth.device_prekeys
                         WHERE device_id = ?1
                           AND kind = 'ONE_TIME'
                           AND consumed_at IS NULL
                           AND expires_at > ?2
                        """)
                .setParameter(1, deviceId)
                .setParameter(2, Timestamp.from(now))
                .getSingleResult();
        return count.intValue();
    }

    @Override
    public long countOneTime(UUID deviceId, Instant now) {
        return countAvailableOneTime(deviceId, now);
    }

    @Override
    public long countOutstandingOneTime(UUID deviceId, Instant now) {
        return countAvailableOneTime(deviceId, now);
    }

    @Override
    public void retireActiveSigned(UUID deviceId, Instant at) {
        entityManager.createNativeQuery("""
                        UPDATE auth.device_prekeys
                           SET retired_at = ?2
                         WHERE device_id = ?1 AND kind = 'SIGNED' AND retired_at IS NULL
                        """)
                .setParameter(1, deviceId)
                .setParameter(2, Timestamp.from(at))
                .executeUpdate();
    }

    /**
     * Uses the SECURITY DEFINER SQL function so consume is atomic even under concurrent
     * claims (SELECT … FOR UPDATE SKIP LOCKED inside the function).
     */
    @Override
    public Optional<DevicePrekey> claimOneTime(UUID deviceId, UUID chatId, Instant now) {
        @SuppressWarnings("unchecked")
        List<Object[]> result = entityManager.createNativeQuery("""
                        SELECT * FROM auth.claim_one_time_prekey(?1, ?2)
                        """)
                .setParameter(1, deviceId)
                .setParameter(2, chatId)
                .getResultList();
        if (result.isEmpty()) {
            return Optional.empty();
        }
        Object[] row = result.get(0);
        if (row == null || row.length < 10 || row[0] == null) {
            return Optional.empty();
        }
        // Composite order: device_id, key_id, kind, public_key, signature, signature_alg,
        // created_at, expires_at, retired_at, consumed_at.
        return Optional.of(new DevicePrekey((UUID) row[0], (String) row[1],
                DevicePrekey.Kind.valueOf((String) row[2]), (byte[]) row[3], (byte[]) row[4],
                instant(row[6]), instant(row[7]), instant(row[8]), instant(row[9])));
    }

    @Override
    public void deleteByDevice(UUID deviceId) {
        entityManager.createNativeQuery("""
                        DELETE FROM auth.device_prekeys WHERE device_id = ?1
                        """)
                .setParameter(1, deviceId)
                .executeUpdate();
    }

    private List<DevicePrekey> rows(String sql, Object... parameters) {
        var query = entityManager.createNativeQuery(sql);
        for (int i = 0; i < parameters.length; i++) {
            query.setParameter(i + 1, parameters[i]);
        }
        @SuppressWarnings("unchecked")
        List<Object[]> result = query.getResultList();
        return result.stream()
                .filter(row -> row != null && row[0] != null)
                .map(row -> new DevicePrekey((UUID) row[0], (String) row[1],
                        DevicePrekey.Kind.valueOf((String) row[2]), (byte[]) row[3],
                        (byte[]) row[4], instant(row[5]), instant(row[6]), instant(row[7]),
                        instant(row[8])))
                .toList();
    }

    static Instant instant(Object value) {
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
