package ru.krug.backend.auth.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.shared.application.model.Base64Url;

/**
 * Read model for device endpoints. Key fields are canonical base64url or null for legacy;
 * {@code signedPrekey}/{@code oneTimePrekeysAvailable} are owner-only enrichments.
 */
public record DeviceView(
        UUID id,
        String name,
        String platform,
        String status,
        boolean e2eeCapable,
        int keyGeneration,
        String identitySigningKey,
        String identityDhKey,
        String identityBindingSignature,
        String identityKeyAlg,
        String fingerprint,
        SignedPrekeyView signedPrekey,
        int oneTimePrekeysAvailable,
        Instant createdAt,
        Instant lastSeenAt) {

    public static DeviceView from(Device device) {
        return new DeviceView(device.id(), device.name(), device.platform().name(),
                device.status().name(), device.isE2eeCapable(), device.keyGeneration(),
                encode(device.identitySigningKey()), encode(device.identityDhKey()),
                encode(device.identityBindingSignature()), device.identityKeyAlg().wireValue(),
                encode(device.fingerprint()), null, 0, device.createdAt(),
                device.lastSeenAt());
    }

    public DeviceView withPrekeys(SignedPrekeyView prekey, int available) {
        return new DeviceView(id, name, platform, status, e2eeCapable, keyGeneration,
                identitySigningKey, identityDhKey, identityBindingSignature, identityKeyAlg,
                fingerprint, prekey, available, createdAt, lastSeenAt);
    }

    private static String encode(byte[] value) {
        return value == null ? null : Base64Url.encode(value);
    }
}
