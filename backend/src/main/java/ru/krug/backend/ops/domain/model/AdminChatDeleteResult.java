package ru.krug.backend.ops.domain.model;

import java.util.UUID;

/**
 * Result of the chat soft-delete: {@code workspaceId} and {@code membersCount} are metadata
 * used for the audit event only; no chat name or message content is read.
 */
public record AdminChatDeleteResult(Outcome outcome, UUID workspaceId, long membersCount) {

    public enum Outcome {
        OK,
        NOT_FOUND,
        ALREADY_DELETED
    }

    public static Outcome outcome(String raw) {
        try {
            return Outcome.valueOf(raw);
        } catch (RuntimeException ex) {
            throw new IllegalStateException("Unexpected admin chat outcome: " + raw, ex);
        }
    }

    public boolean ok() {
        return outcome == Outcome.OK;
    }
}
