package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.command.OneTimePrekeyCommand;
import ru.krug.backend.auth.application.command.SignedPrekeyCommand;
import ru.krug.backend.auth.application.model.PrekeyUploadView;
import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.model.DevicePrekey;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.auth.domain.service.DeviceKeyCrypto;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * SPK rotation + OPK replenishment (§6.2.2). Only the device itself may upload; legacy
 * devices are rejected (never upgraded in place). Duplicate key ids with identical bytes
 * are idempotent, different bytes are a 409.
 */
@Service
public class PrekeyUploadService {

    public static final int MAX_ONE_TIME_PREKEYS = 200;

    private final TenantContext tenantContext;
    private final DeviceRepository deviceRepository;
    private final DevicePrekeyRepository prekeyRepository;
    private final DeviceKeyEvents keyEvents;
    private final ClockPort clock;

    public PrekeyUploadService(TenantContext tenantContext, DeviceRepository deviceRepository,
                               DevicePrekeyRepository prekeyRepository,
                               DeviceKeyEvents keyEvents, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.deviceRepository = deviceRepository;
        this.prekeyRepository = prekeyRepository;
        this.keyEvents = keyEvents;
        this.clock = clock;
    }

    @Transactional
    public PrekeyUploadView upload(Principal principal, UUID deviceId, SignedPrekeyCommand spk,
                                   List<OneTimePrekeyCommand> oneTimePrekeys) {
        tenantContext.activate(principal);
        if (principal.deviceId() == null || !principal.deviceId().equals(deviceId)) {
            throw DomainException.forbidden("X-Device-Id must match the target device");
        }
        Device device = deviceRepository.findById(deviceId)
                .filter(value -> value.userId().equals(principal.userId()))
                .orElseThrow(() -> DomainException.notFound("Device not found"));
        if (device.status() == Device.Status.REVOKED) {
            throw new DomainException(ru.krug.backend.shared.error.ErrorCategory.GONE,
                    ErrorCode.DEVICE_REVOKED, "Device is revoked",
                    Map.of("device_id", deviceId), null);
        }
        if (!device.isE2eeCapable()) {
            throw DomainException.unprocessable(ErrorCode.E2EE_LEGACY_DEVICE,
                    "Legacy devices cannot upload prekeys; register a new device",
                    Map.of("device_id", deviceId, "remedy", "register_new_device"));
        }

        List<OneTimePrekeyCommand> opks = oneTimePrekeys == null ? List.of() : oneTimePrekeys;
        if (spk == null && opks.isEmpty()) {
            throw invalidPrekey("signed_prekey or one_time_prekeys is required");
        }
        validate(spk, opks, device);
        // P2-08 (review-06): serialize prekey uploads of one user before reading the
        // outstanding-OPK count. Without this, two concurrent uploads both observe
        // `available < 200` and together exceed the per-device cap. Retention of expired
        // rows remains a separate B4 debt (no cleanup job yet).
        deviceRepository.lockOwner(principal.userId());

        Instant now = clock.now();
        Instant expiresAt = now.plus(DeviceRegistrationService.PREKEY_TTL);

        int stored = 0;
        boolean spkRotated = false;
        String signedId = null;
        Instant signedExpiresAt = null;
        if (spk != null) {
            DevicePrekey existing = prekeyRepository.find(deviceId, spk.keyId()).orElse(null);
            if (existing != null) {
                if (!sameSigned(existing, spk)) {
                    throw prekeyIdConflict(spk.keyId());
                }
                signedId = existing.keyId();
                signedExpiresAt = existing.expiresAt();
            } else {
                prekeyRepository.retireActiveSigned(deviceId, now);
                prekeyRepository.save(DevicePrekey.signed(deviceId, spk.keyId(),
                        spk.publicKey(), spk.signature(), now, expiresAt));
                spkRotated = true;
                signedId = spk.keyId();
                signedExpiresAt = expiresAt;
            }
        } else {
            DevicePrekey active = prekeyRepository.findActiveSigned(deviceId, now).orElse(null);
            if (active != null) {
                signedId = active.keyId();
                signedExpiresAt = active.expiresAt();
            }
        }

        int available = prekeyRepository.countAvailableOneTime(deviceId, now);
        int newKeys = 0;
        for (OneTimePrekeyCommand opk : opks) {
            DevicePrekey existing = prekeyRepository.find(deviceId, opk.keyId()).orElse(null);
            if (existing != null) {
                if (!sameOneTime(existing, opk)) {
                    throw prekeyIdConflict(opk.keyId());
                }
                continue;
            }
            newKeys++;
        }
        if (available + newKeys > MAX_ONE_TIME_PREKEYS) {
            throw DomainException.unprocessable(ErrorCode.PREKEY_LIMIT_EXCEEDED,
                    "At most " + MAX_ONE_TIME_PREKEYS + " outstanding one-time prekeys",
                    Map.of("limit", MAX_ONE_TIME_PREKEYS, "available", available,
                            "requested", newKeys));
        }
        for (OneTimePrekeyCommand opk : opks) {
            if (prekeyRepository.find(deviceId, opk.keyId()).isPresent()) {
                continue;
            }
            prekeyRepository.save(DevicePrekey.oneTime(deviceId, opk.keyId(),
                    opk.publicKey(), now, expiresAt));
            stored++;
        }
        int after = prekeyRepository.countAvailableOneTime(deviceId, now);
        // P1-03: key material changed -> peers re-read keys, the owner's device list
        // reflects the new prekey availability. An idempotent replay emits nothing.
        if (stored > 0 || spkRotated) {
            keyEvents.prekeysChanged(principal, deviceId, device.keyGeneration());
        }
        return new PrekeyUploadView(deviceId, device.keyGeneration(), signedId,
                signedExpiresAt, stored, after, MAX_ONE_TIME_PREKEYS);
    }

    private static void validate(SignedPrekeyCommand spk, List<OneTimePrekeyCommand> opks,
                                 Device device) {
        if (opks.size() > MAX_ONE_TIME_PREKEYS) {
            throw DomainException.unprocessable(ErrorCode.PREKEY_LIMIT_EXCEEDED,
                    "At most " + MAX_ONE_TIME_PREKEYS + " one-time prekeys per request",
                    Map.of("limit", MAX_ONE_TIME_PREKEYS, "actual", opks.size()));
        }
        Set<String> ids = new HashSet<>();
        if (spk != null) {
            if (!DeviceKeyCrypto.isValidKeyId(spk.keyId())) {
                throw invalidPrekey("signed_prekey.key_id is invalid");
            }
            ids.add(spk.keyId());
            if (spk.publicKey() == null || spk.publicKey().length != 32
                    || spk.signature() == null || spk.signature().length != 64) {
                throw invalidPrekey("signed_prekey key/signature length is invalid");
            }
            if (!DeviceKeyCrypto.verifySignedPrekey(device.identitySigningKey(), spk.keyId(),
                    spk.publicKey(), spk.signature())) {
                throw DomainException.unprocessable(ErrorCode.INVALID_SPK_SIGNATURE,
                        "signed_prekey signature verification failed",
                        Map.of("field", "signed_prekey.signature"));
            }
        }
        for (OneTimePrekeyCommand opk : opks) {
            if (!DeviceKeyCrypto.isValidKeyId(opk.keyId())) {
                throw invalidPrekey("one_time_prekeys.key_id is invalid");
            }
            if (!ids.add(opk.keyId())) {
                throw invalidPrekey("duplicate prekey id " + opk.keyId());
            }
            if (opk.publicKey() == null || opk.publicKey().length != 32) {
                throw invalidPrekey("one_time_prekeys.public_key must be 32 bytes");
            }
        }
    }

    private static boolean sameSigned(DevicePrekey existing, SignedPrekeyCommand spk) {
        return existing.kind() == DevicePrekey.Kind.SIGNED
                && Base64Url.sameBytes(existing.publicKey(), spk.publicKey())
                && Base64Url.sameBytes(existing.signature(), spk.signature());
    }

    private static boolean sameOneTime(DevicePrekey existing, OneTimePrekeyCommand opk) {
        return existing.kind() == DevicePrekey.Kind.ONE_TIME
                && Base64Url.sameBytes(existing.publicKey(), opk.publicKey());
    }

    private static DomainException invalidPrekey(String message) {
        return DomainException.unprocessable(ErrorCode.INVALID_PREKEY, message,
                Map.of("field", "prekeys"));
    }

    private static DomainException prekeyIdConflict(String keyId) {
        return DomainException.conflict(ErrorCode.PREKEY_ID_CONFLICT,
                "The same key_id already exists with different bytes",
                Map.of("key_id", keyId));
    }
}
