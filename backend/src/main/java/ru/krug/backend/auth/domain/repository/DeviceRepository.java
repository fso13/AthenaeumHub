package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.Device;

public interface DeviceRepository {

    void save(Device device);

    /**
     * Flushes pending inserts so a unique/CHECK violation surfaces inside the caller's
     * try/catch (E2EE-REVIEW-04 P2-07) instead of at commit.
     */
    void flush();

    Optional<Device> findById(UUID deviceId);

    long countActive(UUID userId);

    long countActiveE2eeCapable(UUID userId);

    Optional<Device> findActiveByNaturalKey(UUID userId, String name, String platform,
                                            String appVersion);

    /**
     * Non-REVOKED device of {@code userId} carrying the exact identity pair (E2EE
     * idempotency). Scoped by user: peer devices are public but must never be resolved as
     * "mine" (E2EE-REVIEW-04 P1-02).
     */
    Optional<Device> findByPositioningIdentityKeys(UUID userId, byte[] identitySigningKey,
                                                   byte[] identityDhKey);

    /**
     * REVOKED device of {@code userId} carrying the identity pair; registration must
     * answer 410. Another user's revoked pair is a global-uniqueness 409, never a 410.
     */
    Optional<Device> findRevokedByIdentityKeys(UUID userId, byte[] identitySigningKey,
                                               byte[] identityDhKey);

    Optional<Device> findByIdentityDhKey(UUID userId, byte[] identityDhKey);

    Optional<Device> findByIdentitySigningKey(UUID userId, byte[] identitySigningKey);

    List<Device> findAllByUser(UUID userId);

    /** ACTIVE devices of the given workspace chat members (RLS-filtered). */
    List<Device> findActiveByUserIds(List<UUID> userIds);

    boolean isActiveDeviceOfUser(UUID deviceId, UUID userId);

    /**
     * Serialises device registration for one user so the max-5 check cannot race.
     */
    void lockOwner(UUID userId);

    void touchLastSeen(UUID deviceId, Instant at);

    void revoke(UUID deviceId, Instant at);
}
