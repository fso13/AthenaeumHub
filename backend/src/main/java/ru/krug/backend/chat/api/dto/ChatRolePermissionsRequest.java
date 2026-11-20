package ru.krug.backend.chat.api.dto;

/**
 * Partial rights of one role (P0-2). Every field is optional: an absent permission is left
 * unchanged, a present value is written.
 */
public record ChatRolePermissionsRequest(
        Boolean postMessages,
        Boolean inviteMembers,
        Boolean createPolls,
        Boolean startCalls,
        Boolean pinMessages,
        Boolean changeInfo) {
}
