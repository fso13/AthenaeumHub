package ru.krug.backend.chat.api.dto;

/**
 * {@code PATCH /chats/{chatId}/permissions} body and the {@code rights} field of
 * {@code PATCH /chats/{chatId}} (P0-2). An explicit {@code owner} row is rejected with a
 * semantic 422 (OWNER always has every right); a role with no permission values is also 422.
 */
public record ChatPermissionsUpdateRequest(
        ChatRolePermissionsRequest owner,
        ChatRolePermissionsRequest admin,
        ChatRolePermissionsRequest moderator,
        ChatRolePermissionsRequest member,
        ChatRolePermissionsRequest guest) {
}
