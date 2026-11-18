package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.ChatKeysView;
import ru.krug.backend.auth.application.model.DeviceKeyInfoView;
import ru.krug.backend.auth.application.model.VerificationView;
import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.model.DevicePrekey;
import ru.krug.backend.auth.domain.model.KeyVerification;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.auth.domain.repository.KeyVerificationRepository;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code GET /chats/{id}/keys} and {@code PUT /chats/{id}/keys/verification} (§6.2.6/7).
 * Only ACTIVE e2ee-capable devices participate; {@code verified} is scoped to the caller's
 * {@code X-Device-Id}, never inherited by another device of the same user, and is only
 * valid for the key generation that was verified (P2-04).
 */
@Service
public class ChatKeysService {

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;
    private final ChatMemberDirectoryPort chatDirectory;
    private final DeviceRepository deviceRepository;
    private final DevicePrekeyRepository prekeyRepository;
    private final KeyVerificationRepository verificationRepository;
    private final IdempotencyPort idempotency;
    private final RequestCanonicalizer canonicalizer;
    private final DeviceKeyEvents keyEvents;
    private final ClockPort clock;

    public ChatKeysService(TenantContext tenantContext, ChatWorkspacePort chatWorkspace,
                           ChatAccessPort chatAccess, ChatMemberDirectoryPort chatDirectory,
                           DeviceRepository deviceRepository,
                           DevicePrekeyRepository prekeyRepository,
                           KeyVerificationRepository verificationRepository,
                           IdempotencyPort idempotency,
                           RequestCanonicalizer canonicalizer,
                           DeviceKeyEvents keyEvents, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
        this.chatDirectory = chatDirectory;
        this.deviceRepository = deviceRepository;
        this.prekeyRepository = prekeyRepository;
        this.verificationRepository = verificationRepository;
        this.idempotency = idempotency;
        this.canonicalizer = canonicalizer;
        this.keyEvents = keyEvents;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public ChatKeysView getChatKeys(Principal principal, UUID chatId) {
        ScopedChat chat = requireE2eeChat(principal, chatId);
        UUID verifierDeviceId = requireCurrentDevice(principal);
        List<Device> devices = deviceRepository.findActiveByUserIds(chat.members()).stream()
                .filter(Device::isE2eeCapable)
                .toList();
        Map<UUID, KeyVerification> verifications = verificationRepository
                .findByVerifierAndChat(verifierDeviceId, chatId).stream()
                .collect(Collectors.toMap(KeyVerification::targetDeviceId, Function.identity(),
                        (left, right) -> left));
        Instant now = clock.now();
        List<DeviceKeyInfoView> infos = devices.stream()
                .map(device -> toInfo(device, verifierDeviceId, verifications.get(device.id()),
                        prekeyRepository.findActiveSigned(device.id(), now)))
                .toList();
        int verifiedCount = (int) infos.stream()
                .filter(info -> !info.self())
                .filter(info -> Boolean.TRUE.equals(info.verified()))
                .count();
        int otherCount = verificationRepository.countByOtherVerifierDevices(chat.workspaceId(),
                chatId, principal.userId(), verifierDeviceId);
        return new ChatKeysView(chatId, "E2EE", null, principal.deviceId(), verifierDeviceId,
                verifiedCount, otherCount, infos.size(), infos);
    }

    @Transactional
    public VerificationView verifyDevice(Principal principal, UUID chatId, UUID idempotencyKey,
                                         VerificationCommand command) {
        ScopedChat chat = requireE2eeChat(principal, chatId);
        UUID verifierDeviceId = requireCurrentDevice(principal);
        if (command.vhVersion() == null || command.vhVersion() != KeyVerification.VH_VERSION) {
            throw DomainException.unprocessable(ErrorCode.VH_VERSION_UNSUPPORTED,
                    "vh_version must be 2", Map.of("field", "vh_version"));
        }
        KeyVerification.Method method = parseMethod(command.method());
        byte[] hash = Base64Url.decode(command.safetyNumberHash(),
                        KeyVerification.HASH_BYTES)
                .orElseThrow(() -> DomainException.unprocessable(
                        ErrorCode.INVALID_SAFETY_NUMBER_HASH,
                        "safety_number_hash must be 32 canonical base64url bytes",
                        Map.of("field", "safety_number_hash")));
        Device target = deviceRepository.findById(command.deviceId())
                .orElseThrow(() -> DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                        "Unknown device", Map.of("device_id", command.deviceId())));
        if (!chat.members().contains(target.userId())
                || target.status() != Device.Status.ACTIVE) {
            throw DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                    "Device is not an active chat participant",
                    Map.of("device_id", command.deviceId()));
        }
        if (!target.isE2eeCapable()) {
            throw DomainException.unprocessable(ErrorCode.NO_KEYS,
                    "Target device has no E2EE keys", Map.of("device_id", command.deviceId()));
        }

        // P2-05: the verifier declares the key_generation it saw. A different value means
        // the key changed between display and confirmation -> 409 KEY_CHANGED, no write.
        if (command.expectedKeyGeneration() != null
                && command.expectedKeyGeneration() != target.keyGeneration()) {
            throw DomainException.conflict(ErrorCode.KEY_CHANGED,
                    "Target device key generation changed; re-read keys and verify again",
                    Map.of("expected", command.expectedKeyGeneration(),
                            "actual", target.keyGeneration()));
        }

        // The idempotency service re-activates the tenant context; pass the chat workspace
        // so the following key_verifications insert is still inside its RLS scope.
        Principal scoped = principal.withWorkspace(chat.workspaceId());
        String scope = idempotencyScope(chatId);
        byte[] requestHash = canonicalizer.sha256("PUT\n/api/v1/chats/" + chatId
                + "/keys/verification\n" + verifierDeviceId + "\n" + target.id() + "\n"
                + method.name() + "\n" + KeyVerification.VH_VERSION + "\n"
                + Base64Url.encode(hash) + "\n"
                + (command.expectedKeyGeneration() == null ? ""
                        : command.expectedKeyGeneration().toString()));
        IdempotencyReservation reservation = idempotency.reserve(scoped, scope,
                idempotencyKey.toString(), requestHash);
        if (reservation.replay()) {
            return replayView(chatId, verifierDeviceId, reservation.resourceId());
        }

        Instant now = clock.now();
        KeyVerification verification = new KeyVerification(UUID.randomUUID(),
                chat.workspaceId(), chatId, principal.userId(), verifierDeviceId, target.id(),
                target.keyGeneration(), method, KeyVerification.VH_VERSION, hash, now, null);
        verificationRepository.upsert(verification);
        idempotency.complete(scoped, scope, idempotencyKey.toString(), requestHash, 201,
                verification.id());
        keyEvents.verificationChanged(principal, chat.workspaceId(), chatId, target.id(),
                target.keyGeneration());
        return new VerificationView(chatId, verifierDeviceId, target.id(),
                target.keyGeneration(), true, now, method.name());
    }

    /**
     * A repeated {@code Idempotency-Key} must return the original row, including the
     * original {@code verified_at}; the upsert would otherwise overwrite it.
     */
    private VerificationView replayView(UUID chatId, UUID verifierDeviceId, UUID resourceId) {
        if (resourceId == null) {
            throw DomainException.internal();
        }
        KeyVerification stored = verificationRepository.findById(resourceId)
                .orElseThrow(() -> DomainException.conflict(ErrorCode.CONFLICT,
                        "Idempotent replay target is no longer available", Map.of()));
        return new VerificationView(chatId, verifierDeviceId, stored.targetDeviceId(),
                stored.targetKeyGeneration(), stored.revokedAt() == null,
                stored.verifiedAt(), stored.method().name());
    }

    private static String idempotencyScope(UUID chatId) {
        return "PUT /api/v1/chats/" + chatId + "/keys/verification";
    }

    private ScopedChat requireE2eeChat(Principal principal, UUID chatId) {
        UUID workspaceId = chatWorkspace.findWorkspaceForChat(chatId, principal.userId())
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(workspaceId, chatId,
                principal.userId());
        if (!"E2EE".equals(access.securityMode())) {
            throw DomainException.conflict(ErrorCode.MODE_NOT_SUPPORTED,
                    "Chat is not E2EE", Map.of("required_mode", "E2EE"));
        }
        ChatDirectorySnapshot snapshot = chatDirectory.find(workspaceId, chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        return new ScopedChat(workspaceId, snapshot.activeMemberIds());
    }

    /**
     * E2EE-REVIEW-07 P2-07 defense-in-depth: key operations trust {@code X-Device-Id}, but
     * the device must still belong to the authenticated user and be ACTIVE. The device
     * binding filter already enforces this; this guard is deliberately duplicated here so
     * a future path-matching regression cannot make {@code GET /keys} expose another
     * device's {@code my_device_id}/{@code verifier_device_id} or let
     * {@code PUT /verification} select a foreign {@code key_verifications} scope.
     */
    private UUID requireCurrentDevice(Principal principal) {
        UUID deviceId = principal.deviceId();
        if (deviceId == null) {
            throw DomainException.forbidden("X-Device-Id is required for key operations");
        }
        return deviceRepository.findById(deviceId)
                .filter(device -> device.status() == Device.Status.ACTIVE)
                .filter(device -> device.userId().equals(principal.userId()))
                .map(Device::id)
                .orElseThrow(() -> DomainException.forbidden(
                        "X-Device-Id is not an active device of the caller"));
    }

    private static DeviceKeyInfoView toInfo(Device device, UUID verifierDeviceId,
                                            KeyVerification verification,
                                            Optional<DevicePrekey> signed) {
        boolean self = device.id().equals(verifierDeviceId);
        // "Для себя — null": a device never shows a verified badge for itself. A row for a
        // previous key generation is stale and must not read as verified (P2-04).
        boolean currentGeneration = verification != null
                && verification.targetKeyGeneration() == device.keyGeneration();
        Boolean verified = self || !currentGeneration ? null : true;
        return new DeviceKeyInfoView(device.id(), device.userId(), device.platform().name(),
                device.status().name(), Base64Url.encode(device.identitySigningKey()),
                Base64Url.encode(device.identityDhKey()),
                Base64Url.encode(device.identityBindingSignature()),
                device.identityKeyAlg().wireValue(), Base64Url.encode(device.fingerprint()),
                device.keyGeneration(), signed.map(DevicePrekey::keyId).orElse(null),
                self, verified,
                verified == null ? null : verification.verifiedAt(),
                verified == null ? null : verification.method().name(),
                device.lastSeenAt());
    }

    private static KeyVerification.Method parseMethod(String value) {
        try {
            return KeyVerification.Method.valueOf(value);
        } catch (RuntimeException ex) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "method must be QR or MANUAL", Map.of("field", "method"));
        }
    }

    private record ScopedChat(UUID workspaceId, List<UUID> members) {
    }

    /** Application command; the verifier device always comes from X-Device-Id. */
    public record VerificationCommand(UUID deviceId, String method, Integer vhVersion,
                                      String safetyNumberHash,
                                      Integer expectedKeyGeneration) {
    }
}
