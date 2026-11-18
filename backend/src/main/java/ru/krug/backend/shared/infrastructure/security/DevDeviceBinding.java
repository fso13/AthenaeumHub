package ru.krug.backend.shared.infrastructure.security;

import java.util.UUID;

import org.springframework.context.annotation.Profile;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.model.AuthenticatedActor;
import ru.krug.backend.shared.error.DomainException;

/**
 * Dev profile: the HMAC token is device-bound via the signed {@code device_id} claim.
 * No DB lookups are added to the local development loop.
 */
@Component
@Profile({"dev", "test"})
public class DevDeviceBinding implements DeviceBindingStrategy {

    @Override
    public AuthenticatedActor resolve(JwtAuthenticationToken authentication, String deviceHeader,
                                      boolean deviceRequired, String requestId) {
        String claim = authentication.getToken().getClaimAsString("device_id");
        UUID claimDevice = parseUuid(claim);
        boolean headerPresent = deviceHeader != null && !deviceHeader.isBlank();
        // P0-01: never trust an arbitrary header on a non-device-required operation. When
        // the header is present it must match the signed token claim; when the operation
        // requires a device the header is mandatory.
        if (headerPresent) {
            if (!sameUuid(deviceHeader, claim)) {
                throw headerRejected(deviceRequired, "X-Device-Id header does not match the "
                        + "access token");
            }
            return new AuthenticatedActor(userId(authentication), parseUuid(deviceHeader));
        }
        if (deviceRequired) {
            throw new DeviceBindingException("X-Device-Id header is required");
        }
        return new AuthenticatedActor(userId(authentication), claimDevice);
    }

    private static RuntimeException headerRejected(boolean deviceRequired, String message) {
        return deviceRequired
                ? new DeviceBindingException(message)
                : DomainException.forbidden(message);
    }

    private static UUID userId(JwtAuthenticationToken authentication) {
        try {
            return UUID.fromString(authentication.getToken().getSubject());
        } catch (RuntimeException ex) {
            throw new DeviceBindingException("Dev token subject must be a UUID");
        }
    }

    private static boolean sameUuid(String header, String claim) {
        UUID headerUuid = parseUuid(header);
        UUID claimUuid = parseUuid(claim);
        return headerUuid != null && headerUuid.equals(claimUuid);
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.strip());
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
