package ru.krug.backend.chat.domain.model;

import java.util.UUID;

/**
 * Raw outcome of {@code chat.accept_invite} (#79), before HTTP mapping. The enum mirrors
 * the SQL outcome strings one-to-one; unknown strings fail closed as {@code NOT_FOUND}.
 */
public record InviteAcceptance(
        Outcome outcome,
        UUID inviteId,
        UUID workspaceId,
        UUID chatId,
        String role,
        boolean alreadyMember) {

    public enum Outcome {
        OK, NOT_FOUND, FORBIDDEN, CHAT_UNAVAILABLE, REVOKED, EXPIRED, EXHAUSTED, JOIN_CLOSED
    }

    public static InviteAcceptance failed(Outcome outcome) {
        return new InviteAcceptance(outcome, null, null, null, null, false);
    }

    public static Outcome parse(String value) {
        if (value == null) {
            return Outcome.NOT_FOUND;
        }
        try {
            return Outcome.valueOf(value);
        } catch (IllegalArgumentException ex) {
            // Never treat an unknown outcome as success (fail closed).
            return Outcome.NOT_FOUND;
        }
    }
}
