package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.DevicePrekey;

/** Public prekeys only; private keys never reach the server. */
public interface DevicePrekeyRepository {

    void save(DevicePrekey prekey);

    Optional<DevicePrekey> find(UUID deviceId, String keyId);

    List<DevicePrekey> findAll(UUID deviceId);

    Optional<DevicePrekey> findActiveSigned(UUID deviceId, Instant now);

    int countAvailableOneTime(UUID deviceId, Instant now);

    long countOneTime(UUID deviceId, Instant now);

    long countOutstandingOneTime(UUID deviceId, Instant now);

    void retireActiveSigned(UUID deviceId, Instant at);

    /** Atomic consume through {@code auth.claim_one_time_prekey}; null means exhausted. */
    Optional<DevicePrekey> claimOneTime(UUID deviceId, UUID chatId, Instant now);

    void deleteByDevice(UUID deviceId);
}
