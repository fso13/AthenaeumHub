package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.auth.domain.repository.KeyVerificationRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * DELETE /devices/{deviceId} (§6.2.4, §5.4). Revoking is terminal: status=REVOKED,
 * key_generation++, prekeys dropped, all verifications targeting the device revoked, and
 * (P1-03) the key-lifecycle events are emitted in the same transaction: the owner's
 * {@code device.list.changed}, {@code chat.keys.changed(DEVICE_REVOKED)} for every E2EE
 * chat of the owner, and a proactive {@code session.revoked} + 4403 close for the device.
 * Repeating the call is a 204 with no duplicate events; another user's device is a 404.
 */
@Service
public class DeviceRevocationService {

    private final TenantContext tenantContext;
    private final DeviceRepository deviceRepository;
    private final DevicePrekeyRepository prekeyRepository;
    private final KeyVerificationRepository verificationRepository;
    private final DeviceKeyEvents keyEvents;
    private final ClockPort clock;

    public DeviceRevocationService(TenantContext tenantContext,
                                   DeviceRepository deviceRepository,
                                   DevicePrekeyRepository prekeyRepository,
                                   KeyVerificationRepository verificationRepository,
                                   DeviceKeyEvents keyEvents,
                                   ClockPort clock) {
        this.tenantContext = tenantContext;
        this.deviceRepository = deviceRepository;
        this.prekeyRepository = prekeyRepository;
        this.verificationRepository = verificationRepository;
        this.keyEvents = keyEvents;
        this.clock = clock;
    }

    @Transactional
    public void revoke(Principal principal, UUID deviceId) {
        tenantContext.activate(principal);
        Device device = deviceRepository.findById(deviceId)
                .filter(value -> value.userId().equals(principal.userId()))
                .orElseThrow(() -> DomainException.notFound("Device not found"));
        if (device.status() == Device.Status.REVOKED) {
            return;
        }
        Instant now = clock.now();
        deviceRepository.revoke(deviceId, now);
        prekeyRepository.deleteByDevice(deviceId);
        verificationRepository.revokeForTargetDevice(deviceId, now);
        // Mirrors the SQL: LEAST(key_generation + 1, 2147483647).
        int generation = device.keyGeneration() == Device.MAX_KEY_GENERATION
                ? Device.MAX_KEY_GENERATION : device.keyGeneration() + 1;
        keyEvents.deviceRevoked(principal, deviceId, generation);
    }
}
