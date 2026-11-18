package ru.krug.backend.auth.api.mapper;

import java.util.List;
import java.util.Map;

import ru.krug.backend.auth.api.dto.DeviceRegistrationRequest;
import ru.krug.backend.auth.api.dto.OneTimePrekeyRequest;
import ru.krug.backend.auth.api.dto.SignedPrekeyRequest;
import ru.krug.backend.auth.api.dto.SignedPrekeyUploadRequest;
import ru.krug.backend.auth.application.command.DeviceKeyInput;
import ru.krug.backend.auth.application.command.OneTimePrekeyCommand;
import ru.krug.backend.auth.application.command.RegisterDeviceCommand;
import ru.krug.backend.auth.application.command.SignedPrekeyCommand;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * HTTP DTO -> application command. Base64url is decoded strictly here; lengths, key ids and
 * Ed25519 signatures are re-checked by the domain/application service.
 */
public final class DeviceRequestMapper {

    private DeviceRequestMapper() {
    }

    public static RegisterDeviceCommand toCommand(DeviceRegistrationRequest request) {
        boolean keysPresent = request.identitySigningKey() != null
                || request.identityDhKey() != null
                || request.identityBindingSignature() != null
                || request.identityKeyAlg() != null
                || request.signedPrekey() != null
                || (request.oneTimePrekeys() != null && !request.oneTimePrekeys().isEmpty());
        DeviceKeyInput keys = new DeviceKeyInput(
                decode(request.identitySigningKey(), "identity_signing_key"),
                decode(request.identityDhKey(), "identity_dh_key"),
                decode(request.identityBindingSignature(), "identity_binding_signature"),
                request.identityKeyAlg(),
                toCommand(request.signedPrekey()),
                toOneTime(request.oneTimePrekeys()),
                keysPresent);
        return new RegisterDeviceCommand(request.name(), request.platform(),
                request.appVersion(), keys);
    }

    public static SignedPrekeyCommand toCommand(SignedPrekeyRequest request) {
        if (request == null) {
            return null;
        }
        return new SignedPrekeyCommand(request.keyId(),
                decode(request.publicKey(), "signed_prekey.public_key"),
                decode(request.signature(), "signed_prekey.signature"));
    }

    public static List<OneTimePrekeyCommand> toOneTime(List<OneTimePrekeyRequest> requests) {
        if (requests == null) {
            return List.of();
        }
        return requests.stream()
                .map(item -> {
                    // JSON `[null]` must be a 422, never an NPE/500 (P2-11).
                    if (item == null) {
                        throw DomainException.unprocessable(ErrorCode.INVALID_KEY_FORMAT,
                                "one_time_prekeys must not contain null",
                                Map.of("field", "one_time_prekeys"));
                    }
                    return new OneTimePrekeyCommand(item.keyId(),
                            decode(item.publicKey(), "one_time_prekeys.public_key"));
                })
                .toList();
    }

    public static DeviceKeyInput toKeyInput(SignedPrekeyUploadRequest request) {
        return new DeviceKeyInput(null, null, null, null, toCommand(request.signedPrekey()),
                toOneTime(request.oneTimePrekeys()), true);
    }

    private static byte[] decode(String value, String field) {
        if (value == null) {
            return null;
        }
        return Base64Url.decode(value)
                .orElseThrow(() -> DomainException.unprocessable(ErrorCode.INVALID_KEY_FORMAT,
                        "Value is not canonical base64url", Map.of("field", field)));
    }
}
