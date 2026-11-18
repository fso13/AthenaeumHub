package ru.krug.backend.auth.application.usecase;

import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.command.DeviceKeyInput;
import ru.krug.backend.auth.application.command.OneTimePrekeyCommand;
import ru.krug.backend.auth.application.command.RegisterDeviceCommand;
import ru.krug.backend.auth.application.command.SignedPrekeyCommand;
import ru.krug.backend.auth.application.model.DeviceView;
import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.model.DevicePrekey;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.auth.domain.service.DeviceKeyCrypto;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Registers a WEB device, optionally with E2EE device keys (I-01 / §3.1).
 *
 * <p>All-or-none keys: a body without any key field is a legacy registration
 * ({@code identity_key_alg=LEGACY}, {@code e2ee_capable=false}, 201); a partial set is
 * {@code 422 INVALID_KEY_FORMAT}. The natural key is kept only for legacy retries; keyed
 * devices use the identity pair (SPK/OPK are written in the same transaction).
 */
@Service
public class DeviceRegistrationService {

    public static final int MAX_ACTIVE_DEVICES = 5;
    public static final int MAX_ONE_TIME_PREKEYS = 200;
    public static final Duration PREKEY_TTL = Duration.ofDays(30);

    private final TenantContext tenantContext;
    private final DeviceRepository deviceRepository;
    private final DevicePrekeyRepository prekeyRepository;
    private final ClockPort clock;
    private final DeviceKeyEvents keyEvents;

    @Autowired
    public DeviceRegistrationService(TenantContext tenantContext,
                                     DeviceRepository deviceRepository,
                                     DevicePrekeyRepository prekeyRepository, ClockPort clock,
                                     DeviceKeyEvents keyEvents) {
        this.tenantContext = tenantContext;
        this.deviceRepository = deviceRepository;
        this.prekeyRepository = prekeyRepository;
        this.clock = clock;
        this.keyEvents = keyEvents;
    }

    /** Back-compat constructor: no prekey persistence and no key events. */
    public DeviceRegistrationService(TenantContext tenantContext,
                                     DeviceRepository deviceRepository,
                                     DevicePrekeyRepository prekeyRepository, ClockPort clock) {
        this(tenantContext, deviceRepository, prekeyRepository, clock, null);
    }

    /** Unit-test constructor: no prekey persistence and no key events. */
    public DeviceRegistrationService(TenantContext tenantContext,
                                     DeviceRepository deviceRepository, ClockPort clock) {
        this(tenantContext, deviceRepository, null, clock, null);
    }

    @Transactional
    public DeviceView register(Principal principal, RegisterDeviceCommand command) {
        validate(command);
        // Device registration is device-scoped, not workspace-scoped (P1-02): a dev token's
        // workspace claim must not widen what the identity lookups can see.
        tenantContext.activate(principal.withWorkspace(null));
        deviceRepository.lockOwner(principal.userId());

        if (!command.hasKeys()) {
            return registerLegacy(principal, command);
        }
        return registerWithKeys(principal, command);
    }

    /**
     * Spec §3.1 order (0)-(1): a revoked identity pair is 410 and an existing non-revoked
     * pair returns the same device BEFORE the Idempotency-Key is consulted. The full
     * registration path repeats these checks inside its write transaction.
     */
    @Transactional(readOnly = true)
    public Optional<DeviceView> findExistingIdentityPair(Principal principal,
                                                         DeviceKeyInput keys) {
        validateKeyMaterial(keys);
        tenantContext.activate(principal.withWorkspace(null));
        byte[] identitySigningKey = keys.identitySigningKey();
        byte[] identityDhKey = keys.identityDhKey();
        if (deviceRepository.findRevokedByIdentityKeys(principal.userId(), identitySigningKey,
                identityDhKey).isPresent()) {
            throw revoked();
        }
        return deviceRepository.findByPositioningIdentityKeys(principal.userId(),
                        identitySigningKey, identityDhKey)
                .map(device -> {
                    if (!DeviceKeyCrypto.equals(device.identityBindingSignature(),
                            keys.identityBindingSignature())) {
                        throw DomainException.unprocessable(ErrorCode.INVALID_IDENTITY_BINDING,
                                "identity_binding_signature does not match the registered device",
                                Map.of("field", "identity_binding_signature"));
                    }
                    return DeviceView.from(device);
                });
    }

    private static DomainException revoked() {
        return new DomainException(ru.krug.backend.shared.error.ErrorCategory.GONE,
                ErrorCode.DEVICE_REVOKED,
                "This identity key pair belongs to a revoked device",
                Map.of("remedy", "register_new_device"), null);
    }

    private DeviceView registerLegacy(Principal principal, RegisterDeviceCommand command) {
        Optional<Device> existing = deviceRepository.findActiveByNaturalKey(principal.userId(),
                command.name().strip(), command.platform(), command.appVersion().strip());
        if (existing.isPresent()) {
            return DeviceView.from(existing.get());
        }
        requireDeviceSlot(principal.userId());
        Device device = Device.registerLegacy(UUID.randomUUID(), principal.userId(),
                command.name(), command.appVersion(), clock.now());
        deviceRepository.save(device);
        return DeviceView.from(device);
    }

    private DeviceView registerWithKeys(Principal principal, RegisterDeviceCommand command) {
        DeviceKeyInput keys = command.keys();
        validateKeyMaterial(keys);

        byte[] identitySigningKey = keys.identitySigningKey();
        byte[] identityDhKey = keys.identityDhKey();
        byte[] binding = keys.identityBindingSignature();

        // (0) A revoked key pair of THIS user can never be resurrected (P2-5), even under
        // the limit. Another user's revoked pair is caught by global uniqueness (V17) -> 409.
        if (deviceRepository.findRevokedByIdentityKeys(principal.userId(), identitySigningKey,
                identityDhKey).isPresent()) {
            throw revoked();
        }

        // (1) Same identity pair among this user's non-revoked devices -> the same device.
        Optional<Device> existing = deviceRepository.findByPositioningIdentityKeys(
                principal.userId(), identitySigningKey, identityDhKey);
        if (existing.isPresent()) {
            Device device = existing.get();
            if (!DeviceKeyCrypto.equals(device.identityBindingSignature(), binding)) {
                throw DomainException.unprocessable(ErrorCode.INVALID_IDENTITY_BINDING,
                        "identity_binding_signature does not match the registered device",
                        Map.of("field", "identity_binding_signature"));
            }
            return DeviceView.from(device);
        }

        // (2) Either identity key is already bound to this user's other identity -> conflict.
        if (deviceRepository.findByIdentityDhKey(principal.userId(), identityDhKey).isPresent()) {
            throw DomainException.conflict(ErrorCode.IDENTITY_KEY_CONFLICT,
                    "identity_dh_key is already registered to another identity",
                    Map.of("field", "identity_dh_key"));
        }
        if (deviceRepository.findByIdentitySigningKey(principal.userId(), identitySigningKey)
                .isPresent()) {
            throw DomainException.conflict(ErrorCode.IDENTITY_KEY_CONFLICT,
                    "identity_signing_key is already registered to another identity",
                    Map.of("field", "identity_signing_key"));
        }

        requireDeviceSlot(principal.userId());

        byte[] fingerprint = DeviceKeyCrypto.fingerprint(identitySigningKey, identityDhKey);
        Instant now = clock.now();
        Device device = Device.registerWithKeys(UUID.randomUUID(), principal.userId(),
                command.name(), command.appVersion(), identitySigningKey, identityDhKey,
                binding, fingerprint, now);
        // P2-07: flush inside the try. A cross-user duplicate is invisible to the
        // app-level checks (RLS), so the unique index is the only guard and must fail here,
        // before savePrekeys, to become 409 instead of a commit-time 500.
        try {
            deviceRepository.save(device);
            deviceRepository.flush();
        } catch (DataIntegrityViolationException ex) {
            throw classifyIntegrityViolation(ex);
        }
        savePrekeys(device, keys, now);
        if (keyEvents != null) {
            keyEvents.deviceRegistered(principal, device.id(), device.keyGeneration());
        }
        return DeviceView.from(device);
    }

    /**
     * A violated CHECK is malformed key material (422); a violated unique index means the
     * identity pair is already registered somewhere (409). Never logs SQL parameters.
     */
    private static DomainException classifyIntegrityViolation(DataIntegrityViolationException ex) {
        Throwable cause = ex.getMostSpecificCause();
        String message = cause == null || cause.getMessage() == null ? "" : cause.getMessage();
        if (message.contains("ck_devices_")) {
            return DomainException.unprocessable(ErrorCode.INVALID_KEY_FORMAT,
                    "Device key columns violate the all-or-none or length invariant",
                    Map.of("field", "keys"));
        }
        return DomainException.conflict(ErrorCode.IDENTITY_KEY_CONFLICT,
                "Identity keys are already registered",
                Map.of("field", "identity_keys"));
    }

    private void savePrekeys(Device device, DeviceKeyInput keys, Instant now) {
        if (prekeyRepository == null) {
            throw new IllegalStateException("Prekey repository is required for keyed devices");
        }
        Instant expiresAt = now.plus(PREKEY_TTL);
        SignedPrekeyCommand signed = keys.signedPrekey();
        try {
            prekeyRepository.save(DevicePrekey.signed(device.id(), signed.keyId(),
                    signed.publicKey(), signed.signature(), now, expiresAt));
            for (OneTimePrekeyCommand opk : keys.oneTimePrekeys()) {
                prekeyRepository.save(DevicePrekey.oneTime(device.id(), opk.keyId(),
                        opk.publicKey(), now, expiresAt));
            }
        } catch (DataIntegrityViolationException ex) {
            throw DomainException.unprocessable(ErrorCode.INVALID_PREKEY,
                    "Duplicate or invalid prekey", Map.of("field", "one_time_prekeys"));
        }
    }

    private void requireDeviceSlot(UUID userId) {
        if (deviceRepository.countActive(userId) >= MAX_ACTIVE_DEVICES) {
            throw DomainException.conflict(ErrorCode.DEVICE_LIMIT_REACHED,
                    "A user may have at most " + MAX_ACTIVE_DEVICES + " active devices",
                    Map.of("limit", MAX_ACTIVE_DEVICES));
        }
    }

    private static void validateKeyMaterial(DeviceKeyInput keys) {
        if (keys.identitySigningKey() == null || keys.identityDhKey() == null
                || keys.identityBindingSignature() == null || keys.identityKeyAlg() == null
                || keys.signedPrekey() == null) {
            throw invalidKeyFormat("all key fields must be present or none");
        }
        if (!"Ed25519+X25519".equals(keys.identityKeyAlg())) {
            throw invalidKeyFormat("identity_key_alg must be Ed25519+X25519");
        }
        if (keys.identitySigningKey().length != 32 || keys.identityDhKey().length != 32) {
            throw invalidKeyFormat("identity keys must be 32 bytes");
        }
        if (keys.identityBindingSignature().length != 64) {
            throw invalidKeyFormat("identity_binding_signature must be 64 bytes");
        }
        if (!DeviceKeyCrypto.verifyIdentityBinding(keys.identitySigningKey(),
                keys.identityDhKey(), keys.identityBindingSignature())) {
            throw DomainException.unprocessable(ErrorCode.INVALID_IDENTITY_BINDING,
                    "identity_binding_signature verification failed",
                    Map.of("field", "identity_binding_signature"));
        }

        SignedPrekeyCommand signed = keys.signedPrekey();
        validateKeyId(signed.keyId(), "signed_prekey.key_id");
        if (signed.publicKey() == null || signed.publicKey().length != 32) {
            throw invalidKeyFormat("signed_prekey.public_key must be 32 bytes");
        }
        if (signed.signature() == null || signed.signature().length != 64) {
            throw invalidKeyFormat("signed_prekey.signature must be 64 bytes");
        }
        if (!DeviceKeyCrypto.verifySignedPrekey(keys.identitySigningKey(), signed.keyId(),
                signed.publicKey(), signed.signature())) {
            throw DomainException.unprocessable(ErrorCode.INVALID_SPK_SIGNATURE,
                    "signed_prekey signature verification failed",
                    Map.of("field", "signed_prekey.signature"));
        }

        List<OneTimePrekeyCommand> oneTime = keys.oneTimePrekeys();
        if (oneTime.size() > MAX_ONE_TIME_PREKEYS) {
            throw DomainException.unprocessable(ErrorCode.PREKEY_LIMIT_EXCEEDED,
                    "At most " + MAX_ONE_TIME_PREKEYS + " one-time prekeys are allowed",
                    Map.of("limit", MAX_ONE_TIME_PREKEYS, "actual", oneTime.size()));
        }
        Set<String> ids = new HashSet<>();
        ids.add(signed.keyId());
        for (OneTimePrekeyCommand opk : oneTime) {
            validateKeyId(opk.keyId(), "one_time_prekeys.key_id");
            if (!ids.add(opk.keyId())) {
                throw DomainException.unprocessable(ErrorCode.INVALID_PREKEY,
                        "Duplicate prekey id", Map.of("key_id", opk.keyId()));
            }
            if (opk.publicKey() == null || opk.publicKey().length != 32) {
                throw invalidKeyFormat("one_time_prekeys.public_key must be 32 bytes");
            }
        }
    }

    private static void validateKeyId(String keyId, String field) {
        if (!DeviceKeyCrypto.isValidKeyId(keyId)) {
            throw DomainException.unprocessable(ErrorCode.INVALID_KEY_FORMAT,
                    "key_id must be 1..64 of [A-Za-z0-9._-]",
                    Map.of("field", field));
        }
    }

    private static DomainException invalidKeyFormat(String message) {
        return DomainException.unprocessable(ErrorCode.INVALID_KEY_FORMAT, message,
                Map.of("field", "keys"));
    }

    private static void validate(RegisterDeviceCommand command) {
        if (command == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        if (!"WEB".equals(command.platform())) {
            throw DomainException.badRequest("Only platform=WEB is supported",
                    Map.of("field", "platform", "allowed", "WEB"));
        }
        if (command.name() == null || command.name().isBlank()
                || command.name().strip().length() > Device.MAX_NAME_LENGTH) {
            throw DomainException.badRequest("name must be 1..80 characters",
                    Map.of("field", "name", "max_length", Device.MAX_NAME_LENGTH));
        }
        if (command.appVersion() == null || command.appVersion().isBlank()
                || command.appVersion().strip().length() > Device.MAX_APP_VERSION_LENGTH) {
            throw DomainException.badRequest("app_version must be 1..40 characters",
                    Map.of("field", "app_version",
                            "max_length", Device.MAX_APP_VERSION_LENGTH));
        }
    }
}
