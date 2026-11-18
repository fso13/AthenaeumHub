package ru.krug.backend.message.application.model;

import java.util.Arrays;
import java.util.UUID;

/**
 * Public device projection needed by E2EE fan-out: identity keys and generation only.
 * The private key material never leaves the client.
 */
public record MessageDeviceView(UUID deviceId, UUID userId, int keyGeneration, boolean active,
                                boolean e2eeCapable, byte[] identitySigningKey,
                                byte[] identityDhKey) {

    public MessageDeviceView {
        identitySigningKey = copy(identitySigningKey);
        identityDhKey = copy(identityDhKey);
    }

    private static byte[] copy(byte[] value) {
        return value == null ? null : Arrays.copyOf(value, value.length);
    }

    @Override
    public byte[] identitySigningKey() {
        return copy(identitySigningKey);
    }

    @Override
    public byte[] identityDhKey() {
        return copy(identityDhKey);
    }
}
