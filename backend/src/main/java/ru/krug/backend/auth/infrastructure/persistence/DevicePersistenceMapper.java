package ru.krug.backend.auth.infrastructure.persistence;

import ru.krug.backend.auth.domain.model.Device;

public final class DevicePersistenceMapper {

    private DevicePersistenceMapper() {
    }

    public static Device toDomain(DeviceEntity entity) {
        Device.IdentityKeyAlg alg = entity.getIdentityKeyAlg() == null
                ? Device.IdentityKeyAlg.LEGACY
                : Device.IdentityKeyAlg.fromWire(entity.getIdentityKeyAlg());
        return Device.reconstitute(entity.getId(), entity.getUserId(), entity.getName(),
                Device.Platform.valueOf(entity.getPlatform()), entity.getAppVersion(),
                Device.Status.valueOf(entity.getStatus()), alg,
                entity.getIdentitySigningKey(), entity.getIdentityDhKey(),
                entity.getIdentityBindingSignature(), entity.getFingerprint(),
                entity.getKeyGeneration() == null ? 1 : entity.getKeyGeneration(),
                entity.getCreatedAt(), entity.getLastSeenAt(), entity.getRevokedAt());
    }
}
