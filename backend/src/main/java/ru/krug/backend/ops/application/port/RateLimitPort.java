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

    /**
     * P0-1 (#79): invite-token accept guard. A link token is a bearer secret, so a caller
     * must not be able to enumerate/retry it unboundedly. The window is per user and
     * independent from message/claim windows.
     *
     * @throws ru.krug.backend.shared.error.DomainException 429 {@code RATE_LIMITED} with
     *         {@code Retry-After} when the window is exhausted
     */
    void checkInviteAccept(Principal principal);

    /**
     * P0-1 (#79): invite-link creation guard, per channel. A link is a bearer secret, so a
     * chat cannot mint them unboundedly.
     *
     * @throws ru.krug.backend.shared.error.DomainException 429 {@code RATE_LIMITED} with
     *         {@code Retry-After} when the window is exhausted
     */
    void checkInviteCreate(Principal principal, UUID chatId);

    /**
     * #96: bot message-send guard. A bot credential is a bearer secret with no user session,
     * so it gets its own per-bot and per-chat windows, independent of user sends.
     *
     * @throws ru.krug.backend.shared.error.DomainException 429 {@code RATE_LIMITED} with
     *         {@code Retry-After} when a window is exhausted
     */
    void checkBotSend(UUID botId, UUID chatId);
}
