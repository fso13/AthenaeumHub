package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.domain.model.Device;

/**
 * E2EE-REVIEW-06 P2-05: the domain capability predicate must be the exact mirror of
 * {@code auth.device_is_e2ee_capable(...)} (V17): ACTIVE + Ed25519+X25519 + all four key
 * fields with exact lengths, including the fingerprint.
 */
class DeviceCapabilityTest {

    private static final Instant NOW = Instant.parse("2026-11-17T00:00:00Z");

    @Test
    void keyedActiveDeviceIsCapable() {
        Device device = Device.registerWithKeys(UUID.randomUUID(), UUID.randomUUID(), "d",
                "0.7.0", bytes(32), bytes(32), bytes(64), bytes(32), NOW);
        assertThat(device.isE2eeCapable()).isTrue();
    }

    @Test
    void revokedDeviceIsNeverCapable() {
        Device device = Device.registerWithKeys(UUID.randomUUID(), UUID.randomUUID(), "d",
                "0.7.0", bytes(32), bytes(32), bytes(64), bytes(32), NOW);
        assertThat(device.revoke(NOW).isE2eeCapable()).isFalse();
    }

    @Test
    void legacyDeviceIsNeverCapable() {
        Device device = Device.registerLegacy(UUID.randomUUID(), UUID.randomUUID(), "d",
                "0.7.0", NOW);
        assertThat(device.isE2eeCapable()).isFalse();
    }

    private static byte[] bytes(int size) {
        byte[] value = new byte[size];
        for (int i = 0; i < size; i++) {
            value[i] = (byte) (i + 1);
        }
        return value;
    }
}
