package ru.krug.backend.auth.application.usecase;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.command.DeviceKeyInput;
import ru.krug.backend.auth.application.command.OneTimePrekeyCommand;
import ru.krug.backend.auth.application.command.RegisterDeviceCommand;
import ru.krug.backend.auth.application.command.SignedPrekeyCommand;
import ru.krug.backend.auth.application.model.DeviceRegistrationResult;
import ru.krug.backend.auth.application.model.DeviceView;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;

/**
 * Idempotency orchestration for {@code POST /devices}: reserve the key, create the device
 * in one transaction, then complete; a replay is resolved by the immutable device id.
 */
@Service
public class RegisterDeviceUseCase {

    public static final String IDEMPOTENCY_SCOPE = "POST /api/v1/devices";
    private static final Logger log = LoggerFactory.getLogger(RegisterDeviceUseCase.class);

    private final IdempotencyPort idempotency;
    private final DeviceRegistrationService registration;
    private final DeviceQueryService query;
    private final RequestCanonicalizer canonicalizer;

    public RegisterDeviceUseCase(IdempotencyPort idempotency,
                                 DeviceRegistrationService registration,
                                 DeviceQueryService query,
                                 RequestCanonicalizer canonicalizer) {
        this.idempotency = idempotency;
        this.registration = registration;
        this.query = query;
        this.canonicalizer = canonicalizer;
    }

    public DeviceRegistrationResult register(Principal principal, UUID key,
                                             RegisterDeviceCommand command) {
        // §3.1 order: revoked pair -> 410 and existing pair -> same device happen before
        // the Idempotency-Key. Only after them do we reserve/replay the key.
        if (command != null && command.hasKeys()) {
            var existing = registration.findExistingIdentityPair(principal, command.keys());
            if (existing.isPresent()) {
                DeviceView enriched = query.findById(principal, existing.get().id());
                return new DeviceRegistrationResult(201, enriched, false);
            }
        }

        byte[] hash = canonicalizer.sha256("POST\n/api/v1/devices\n"
                + canonicalizer.canonicalize(canonicalBody(command)));

        IdempotencyReservation reservation = idempotency.reserve(principal,
                IDEMPOTENCY_SCOPE, key.toString(), hash);
        if (reservation.replay()) {
            DeviceView replayed = query.findById(principal, reservation.resourceId());
            return new DeviceRegistrationResult(201, replayed, true);
        }

        try {
            DeviceView device = registration.register(principal, command);
            // The registration view has no owner-only prekey aggregates; re-read enriched.
            DeviceView enriched = query.findById(principal, device.id());
            idempotency.complete(principal, IDEMPOTENCY_SCOPE, key.toString(), hash, 201,
                    device.id());
            return new DeviceRegistrationResult(201, enriched, false);
        } catch (RuntimeException ex) {
            abandonQuietly(principal, key);
            throw ex;
        }
    }

    private static Map<String, Object> canonicalBody(RegisterDeviceCommand command) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("name", command.name());
        canonical.put("platform", command.platform());
        canonical.put("app_version", command.appVersion());
        DeviceKeyInput keys = command.keys();
        if (keys != null && keys.anyFieldPresent()) {
            canonical.put("identity_signing_key", encode(keys.identitySigningKey()));
            canonical.put("identity_dh_key", encode(keys.identityDhKey()));
            canonical.put("identity_binding_signature",
                    encode(keys.identityBindingSignature()));
            canonical.put("identity_key_alg", keys.identityKeyAlg());
            SignedPrekeyCommand spk = keys.signedPrekey();
            if (spk != null) {
                canonical.put("signed_prekey", Map.of(
                        "key_id", spk.keyId(),
                        "public_key", encode(spk.publicKey()),
                        "signature", encode(spk.signature())));
            }
            List<Map<String, Object>> oneTime = keys.oneTimePrekeys().stream()
                    .map(RegisterDeviceUseCase::oneTimeCanonical)
                    .toList();
            canonical.put("one_time_prekeys", oneTime);
        }
        return canonical;
    }

    private static Map<String, Object> oneTimeCanonical(OneTimePrekeyCommand opk) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("key_id", opk.keyId());
        item.put("public_key", encode(opk.publicKey()));
        return item;
    }

    private static String encode(byte[] value) {
        return value == null ? null : Base64Url.encode(value);
    }

    private void abandonQuietly(Principal principal, UUID key) {
        try {
            idempotency.abandon(principal, IDEMPOTENCY_SCOPE, key.toString());
        } catch (RuntimeException ex) {
            log.warn("Could not release device idempotency reservation request_id={}",
                    principal.requestId());
        }
    }
}
