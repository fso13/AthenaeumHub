package ru.krug.backend.ops.application.port;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

public interface RateLimitPort {

    void checkMessageSend(Principal principal, UUID chatId);

    /**
     * E2EE prekey claim guard (E2EE-SPEC §3.2, E2EE-REVIEW-04 P1-01). Claim is not
     * idempotent — every call may consume one one-time prekey — so it must be bounded per
     * caller, per chat and per target device before the claim loop runs.
     *
     * @throws ru.krug.backend.shared.error.DomainException 429 {@code RATE_LIMITED} with
     *         {@code Retry-After} when any window is exhausted
     */
    void checkKeyClaim(Principal principal, UUID chatId, UUID targetDeviceId);
}
