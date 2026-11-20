package ru.krug.backend.chat.api.dto;

/**
 * {@code GET/PATCH /chats/{chatId}/permissions} (P0-2): the complete effective matrix.
 * {@code owner} is always all-true and cannot be changed.
 */
public record ChatPermissionsResponse(
        ChatRolePermissionsResponse owner,
        ChatRolePermissionsResponse admin,
        ChatRolePermissionsResponse moderator,
        ChatRolePermissionsResponse member,
        ChatRolePermissionsResponse guest) {
}
