package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.KeyClaimView;
import ru.krug.backend.auth.application.model.OneTimePrekeyView;
import ru.krug.backend.auth.application.model.PrekeyBundleView;
import ru.krug.backend.auth.application.model.SignedPrekeyView;
import ru.krug.backend.auth.application.model.UnavailableDeviceView;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.model.DevicePrekey;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Atomic prekey-bundle claim (§6.2.5). The chat_id is mandatory: membership is checked in
 * that chat and in the current workspace. One OPK per device is consumed; exhaustion is
 * not an error (otp_exhausted=true). A non-member/unknown device rejects the whole request
 * with the same 422 so device existence is not disclosed.
 */
@Service
public class KeyClaimService {

    public static final int MAX_DEVICES = 10;

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;
    private final ChatMemberDirectoryPort chatDirectory;
    private final DeviceRepository deviceRepository;
    private final DevicePrekeyRepository prekeyRepository;
    private final RateLimitPort rateLimit;
    private final ClockPort clock;

    public KeyClaimService(TenantContext tenantContext, ChatWorkspacePort chatWorkspace,
                           ChatAccessPort chatAccess, ChatMemberDirectoryPort chatDirectory,
                           DeviceRepository deviceRepository,
                           DevicePrekeyRepository prekeyRepository,
                           RateLimitPort rateLimit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
        this.chatDirectory = chatDirectory;
        this.deviceRepository = deviceRepository;
        this.prekeyRepository = prekeyRepository;
        this.rateLimit = rateLimit;
        this.clock = clock;
    }

    @Transactional
    public KeyClaimView claim(Principal principal, UUID chatId, List<DeviceRef> requested) {
        if (chatId == null) {
            throw DomainException.badRequest("chat_id is required", Map.of("field", "chat_id"));
        }
        if (requested == null || requested.isEmpty()) {
            throw DomainException.badRequest("devices must not be empty",
                    Map.of("field", "devices"));
        }
        if (requested.size() > MAX_DEVICES) {
            throw DomainException.unprocessable(ErrorCode.TOO_MANY_DEVICES,
                    "At most " + MAX_DEVICES + " devices may be claimed",
                    Map.of("limit", MAX_DEVICES, "actual", requested.size()));
        }
        Set<UUID> unique = new HashSet<>();
        for (DeviceRef ref : requested) {
            if (ref == null || ref.deviceId() == null || ref.userId() == null
                    || !unique.add(ref.deviceId())) {
                throw unknownDevice(null);
            }
        }

        UUID workspaceId = chatWorkspace.findWorkspaceForChat(chatId, principal.userId())
                .orElseThrow(() -> DomainException.forbidden("Not a member of this chat"));
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(workspaceId, chatId,
                principal.userId());
        ChatDirectorySnapshot chat = chatDirectory.find(workspaceId, chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        if (access.securityMode() == null) {
            throw DomainException.notFound("Chat not found");
        }
        Set<UUID> members = new HashSet<>(chat.activeMemberIds());
        // P1-01: claim is not idempotent — every accepted call may burn one one-time
        // prekey. Bound it per caller, per chat and per target device before the loop.
        // A rejected request has not touched any OPK.
        for (DeviceRef ref : requested) {
            rateLimit.checkKeyClaim(principal, chatId, ref.deviceId());
        }
        Instant now = clock.now();

        List<PrekeyBundleView> bundles = new ArrayList<>();
        List<UnavailableDeviceView> unavailable = new ArrayList<>();
        for (DeviceRef ref : requested) {
            Device device = deviceRepository.findById(ref.deviceId())
                    .orElseThrow(() -> unknownDevice(ref.deviceId()));
            if (!device.userId().equals(ref.userId()) || !members.contains(device.userId())
                    || device.status() != Device.Status.ACTIVE) {
                throw unknownDevice(ref.deviceId());
            }
            if (!device.isE2eeCapable()) {
                unavailable.add(new UnavailableDeviceView(device.id(), "NO_KEYS"));
                continue;
            }
            DevicePrekey spk = prekeyRepository.findActiveSigned(device.id(), now).orElse(null);
            if (spk == null) {
                unavailable.add(new UnavailableDeviceView(device.id(), "NO_SPK"));
                continue;
            }
            DevicePrekey opk;
            try {
                opk = prekeyRepository.claimOneTime(device.id(), chatId, now).orElse(null);
            } catch (DataAccessException ex) {
                throw unknownDevice(device.id());
            }
            bundles.add(new PrekeyBundleView(device.userId(), device.id(),
                    device.keyGeneration(), Base64Url.encode(device.identitySigningKey()),
                    Base64Url.encode(device.identityDhKey()),
                    Base64Url.encode(device.identityBindingSignature()),
                    device.identityKeyAlg().wireValue(),
                    new SignedPrekeyView(spk.keyId(), Base64Url.encode(spk.publicKey()),
                            Base64Url.encode(spk.signature()), spk.createdAt(),
                            spk.expiresAt()),
                    opk == null ? null : new OneTimePrekeyView(opk.keyId(),
                            Base64Url.encode(opk.publicKey())),
                    opk == null));
        }
        if (bundles.isEmpty()) {
            throw DomainException.conflict(ErrorCode.NO_PREKEYS,
                    "No prekey bundles are available for the requested devices",
                    Map.of("devices", requested.stream().map(DeviceRef::deviceId)
                            .map(UUID::toString).toList()));
        }
        return new KeyClaimView(bundles, unavailable);
    }

    private static DomainException unknownDevice(UUID deviceId) {
        Map<String, Object> details = deviceId == null ? Map.of("reason", "invalid_device_ref")
                : Map.of("device_id", deviceId.toString());
        return DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                "Unknown device or the device is not an active chat participant", details);
    }

    /** Application-level device reference (user_id must match the device owner). */
    public record DeviceRef(UUID deviceId, UUID userId) {
    }
}
