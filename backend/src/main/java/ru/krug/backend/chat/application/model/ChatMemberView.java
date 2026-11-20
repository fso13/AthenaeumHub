package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.chat.domain.model.ChatMemberRow;

/** One ACTIVE channel member as exposed by the API (#79). */
public record ChatMemberView(
        UUID userId,
        String displayName,
        String role,
        String status,
        Instant joinedAt) {

    public static ChatMemberView from(ChatMemberRow row) {
        return new ChatMemberView(row.userId(), row.displayName(), row.role(), row.status(),
                row.joinedAt());
    }
}
