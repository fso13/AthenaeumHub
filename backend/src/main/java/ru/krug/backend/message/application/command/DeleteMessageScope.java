package ru.krug.backend.message.application.command;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/** Query semantics of {@code DELETE /chats/{chatId}/messages/{messageId}?scope=...}. */
public enum DeleteMessageScope {

    /** Hide the message only from the caller's own timeline. */
    ME,

    /** Tombstone for every member; sender-only. */
    ALL;

    public static DeleteMessageScope parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return ME;
        }
        return switch (raw.trim().toLowerCase(java.util.Locale.ROOT)) {
            case "me" -> ME;
            case "all" -> ALL;
            default -> throw DomainException.badRequest("scope must be me or all",
                    Map.of("field", "scope", "allowed", "me,all"));
        };
    }
}
