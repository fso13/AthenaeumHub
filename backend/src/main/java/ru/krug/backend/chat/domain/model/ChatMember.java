package ru.krug.backend.chat.domain.model;

import java.util.Objects;
import java.util.UUID;

public final class ChatMember {

    public enum Role {
        OWNER, ADMIN, MODERATOR, MEMBER, GUEST
    }

    public enum Status {
        INVITED, ACTIVE, REMOVED
    }

    private final UUID chatId;
    private final UUID userId;
    private final Role role;
    private final Status status;

    private ChatMember(UUID chatId, UUID userId, Role role, Status status) {
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.role = Objects.requireNonNull(role, "role");
        this.status = Objects.requireNonNull(status, "status");
    }

    public static ChatMember owner(UUID chatId, UUID userId) {
        return new ChatMember(chatId, userId, Role.OWNER, Status.ACTIVE);
    }

    public static ChatMember reconstitute(UUID chatId, UUID userId, Role role, Status status) {
        return new ChatMember(chatId, userId, role, status);
    }

    public boolean isActive() {
        return status == Status.ACTIVE;
    }

    public UUID chatId() {
        return chatId;
    }

    public UUID userId() {
        return userId;
    }

    public Role role() {
        return role;
    }

    public Status status() {
        return status;
    }
}
