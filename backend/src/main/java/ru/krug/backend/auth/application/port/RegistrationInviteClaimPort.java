package ru.krug.backend.auth.application.port;

import java.util.UUID;

/**
 * #100 post-verification workspace invite claim. The auth flow owns registration/verification
 * and publishes only the user id plus the stored SHA-256 token digest; the workspace context
 * owns invite semantics and calls the same atomic accept function as a normal accept.
 *
 * <p>Implementations must be idempotent and must not throw for expected invite states
 * (expired/revoked/exhausted/mismatched): verification already succeeded.</p>
 */
public interface RegistrationInviteClaimPort {

    void claim(UUID userId, String inviteTokenHash, String requestId);
}
