package ru.krug.backend.shared.infrastructure.security;

import java.util.UUID;

import org.springframework.context.annotation.Profile;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.model.AuthenticatedUser;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.port.DeviceBindingPort;
import ru.krug.backend.auth.application.port.JitProvisioningPort;
import ru.krug.backend.shared.application.model.AuthenticatedActor;
import ru.krug.backend.shared.error.DomainException;

/**
 * Keycloak profile: JIT-provision the local user from the token subject, then verify that
 * {@code X-Device-Id} belongs to that user and is ACTIVE.
 */
@Component
@Profile({"keycloak", "prod"})
public class KeycloakDeviceBinding implements DeviceBindingStrategy {

    private final JitProvisioningPort jitProvisioning;
    private final DeviceBindingPort deviceBinding;

    public KeycloakDeviceBinding(JitProvisioningPort jitProvisioning,
                                 DeviceBindingPort deviceBinding) {
        this.jitProvisioning = jitProvisioning;
        this.deviceBinding = deviceBinding;
    }

    @Override
    public AuthenticatedActor resolve(JwtAuthenticationToken authentication, String deviceHeader,
                                      boolean deviceRequired, String requestId) {
        KeycloakIdentity identity = KeycloakClaims.identity(authentication.getToken());
        AuthenticatedUser user = jitProvisioning.ensure(identity, requestId);

        // E2EE-REVIEW-06 P0-01: a header that is present must always be validated, even on
        // operations where the contract does not require it. Otherwise a forged header can
        // still influence consumers of principal.deviceId (keys/verification/mark-read).
        boolean headerPresent = deviceHeader != null && !deviceHeader.isBlank();
        UUID headerDevice = KeycloakClaims.parseUuid(deviceHeader);
        if (headerPresent) {
            if (headerDevice == null) {
                throw headerRejected(deviceRequired, "X-Device-Id header is malformed");
            }
            if (!deviceBinding.isActiveDeviceOfUser(headerDevice, user.userId())) {
                throw headerRejected(deviceRequired, "Device is not registered to this user "
                        + "or is not ACTIVE");
            }
        } else if (deviceRequired) {
            throw new DeviceBindingException("X-Device-Id header is required");
        }
        return new AuthenticatedActor(user.userId(), headerDevice);
    }

    /**
     * A forged header on a device-required operation is an authentication failure (401);
     * on an operation that does not require the header it is a forbidden actor (403), which
     * preserves the endpoint-level semantics while still validating every present header.
     */
    private static RuntimeException headerRejected(boolean deviceRequired, String message) {
        return deviceRequired
                ? new DeviceBindingException(message)
                : DomainException.forbidden(message);
    }
}
