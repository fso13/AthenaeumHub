package ru.krug.backend.chat.application.command;

/**
 * {@code POST /chats/{chatId}/invites} (#79). All fields are optional: the service applies
 * the documented defaults (MEMBER, 7 days, unlimited uses).
 */
public record ChatInviteCreateCommand(String role, Integer maxUses, Long expiresInSeconds) {
}
