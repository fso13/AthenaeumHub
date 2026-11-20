package ru.krug.backend.chat.api.dto;

/** Effective rights of one role (P0-2); every flag is always present. */
public record ChatRolePermissionsResponse(
        boolean postMessages,
        boolean inviteMembers,
        boolean createPolls,
        boolean startCalls,
        boolean pinMessages,
        boolean changeInfo) {
}
