package ru.krug.backend.chat.application.model;

import java.util.List;
import java.util.UUID;

/**
 * {@code GET /chats/{chatId}/members} (#79): detailed member rows plus the legacy flat id
 * projection used by the group-call participant picker.
 */
public record ChatMemberListView(List<UUID> userIds, List<ChatMemberView> members) {

    public ChatMemberListView {
        userIds = List.copyOf(userIds);
        members = List.copyOf(members);
    }
}
