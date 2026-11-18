package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.DeviceView;
import ru.krug.backend.auth.application.model.SignedPrekeyView;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.model.DevicePrekey;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

@Service
public class DeviceQueryService {

    private final TenantContext tenantContext;
    private final DeviceRepository deviceRepository;
    private final DevicePrekeyRepository prekeyRepository;
    private final ClockPort clock;

    public DeviceQueryService(TenantContext tenantContext, DeviceRepository deviceRepository,
                              DevicePrekeyRepository prekeyRepository, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.deviceRepository = deviceRepository;
        this.prekeyRepository = prekeyRepository;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public DeviceView findById(Principal principal, UUID deviceId) {
        tenantContext.activate(principal);
        return deviceRepository.findById(deviceId)
                .filter(device -> device.userId().equals(principal.userId()))
                .map(this::enrich)
                .orElseThrow(() -> DomainException.notFound("Device not found"));
    }

    @Transactional(readOnly = true)
    public List<DeviceView> listDevices(Principal principal) {
        tenantContext.activate(principal);
        return deviceRepository.findAllByUser(principal.userId()).stream()
                .map(this::enrich)
                .toList();
    }

    /** Owner-only prekey availability; public key bytes are canonical base64url. */
    public DeviceView enrich(Device device) {
        Instant now = clock.now();
        DevicePrekey signed = prekeyRepository.findActiveSigned(device.id(), now).orElse(null);
        int available = prekeyRepository.countAvailableOneTime(device.id(), now);
        SignedPrekeyView view = signed == null ? null
                : new SignedPrekeyView(signed.keyId(), Base64Url.encode(signed.publicKey()),
                        signed.signature() == null ? null : Base64Url.encode(signed.signature()),
                        signed.createdAt(), signed.expiresAt());
        return DeviceView.from(device).withPrekeys(view, available);
    }
}
