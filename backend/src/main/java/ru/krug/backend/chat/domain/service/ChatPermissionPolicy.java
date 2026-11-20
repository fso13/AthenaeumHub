package ru.krug.backend.chat.domain.service;

import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Built-in channel rights matrix (P0-2 / #80) and the rules around editing it.
 *
 * <p>Defaults follow SYSTEM-ANALYSIS §10.3 ({@code message.pin} is MODERATOR+, channel info
 * and settings are ADMIN+, write is everybody) extended with product decisions for polls and
 * calls that the RBAC table does not list. {@code OWNER} always has every right and is not
 * editable; every other role can be changed per chat.</p>
 *
 * <p>The database stores the effective matrix per chat; this class is the single source of
 * truth for the defaults (used when a channel is created and as a defensive fallback if a
 * row is missing) and for validation of PATCH input.</p>
 */
public final class ChatPermissionPolicy {

    private static final Map<ChatMember.Role, Map<ChatPermission, Boolean>> DEFAULTS;

    static {
        Map<ChatMember.Role, Map<ChatPermission, Boolean>> defaults =
                new EnumMap<>(ChatMember.Role.class);
        defaults.put(ChatMember.Role.OWNER, all(true));
        defaults.put(ChatMember.Role.ADMIN, all(true));
        defaults.put(ChatMember.Role.MODERATOR, matrix(true, true, true, true, true, false));
        defaults.put(ChatMember.Role.MEMBER, matrix(true, false, true, true, false, false));
        defaults.put(ChatMember.Role.GUEST, matrix(true, false, false, false, false, false));
        DEFAULTS = Collections.unmodifiableMap(defaults);
    }

    private ChatPermissionPolicy() {
    }

    /** Immutable default matrix for one role (all six permissions present). */
    public static Map<ChatPermission, Boolean> defaults(ChatMember.Role role) {
        return DEFAULTS.get(role);
    }

    public static boolean defaultAllowed(ChatMember.Role role, ChatPermission permission) {
        return DEFAULTS.get(role).getOrDefault(permission, false);
    }

    /** OWNER rights are fixed; {@code OWNER} is rejected as a PATCH target. */
    public static ChatMember.Role requireEditableRole(String roleLiteral) {
        ChatMember.Role role = parseRole(roleLiteral);
        if (role == ChatMember.Role.OWNER) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "OWNER rights are fixed and cannot be changed",
                    Map.of("field", "role", "reason", "owner_permissions_fixed"));
        }
        return role;
    }

    public static ChatMember.Role parseRole(String roleLiteral) {
        if (roleLiteral == null || roleLiteral.isBlank()) {
            throw DomainException.badRequest("role is required", Map.of("field", "role"));
        }
        try {
            return ChatMember.Role.valueOf(roleLiteral);
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("role is invalid",
                    Map.of("field", "role",
                            "allowed", "OWNER,ADMIN,MODERATOR,MEMBER,GUEST"));
        }
    }

    public static boolean canManage(String role) {
        return "OWNER".equals(role) || "ADMIN".equals(role);
    }

    /**
     * Parses a wire-shaped rights patch ({@code {"ADMIN": {"post_messages": false}}}) into
     * domain enums. An unknown role/permission or an OWNER row is rejected; an empty map
     * yields an empty patch (the caller decides whether that is an error).
     */
    public static Map<ChatMember.Role, Map<ChatPermission, Boolean>> parsePatch(
            Map<String, Map<String, Boolean>> raw) {
        if (raw == null || raw.isEmpty()) {
            return Map.of();
        }
        Map<ChatMember.Role, Map<ChatPermission, Boolean>> patch =
                new java.util.EnumMap<>(ChatMember.Role.class);
        for (Map.Entry<String, Map<String, Boolean>> entry : raw.entrySet()) {
            ChatMember.Role role = requireEditableRole(entry.getKey());
            Map<String, Boolean> values = entry.getValue();
            if (values == null || values.isEmpty()) {
                throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                        "A role patch must contain at least one permission",
                        Map.of("field", "rights", "role", role.name()));
            }
            Map<ChatPermission, Boolean> parsed =
                    new java.util.EnumMap<>(ChatPermission.class);
            for (Map.Entry<String, Boolean> value : values.entrySet()) {
                ChatPermission permission = ChatPermission.fromWire(value.getKey());
                if (permission == null) {
                    throw DomainException.badRequest("permission is invalid",
                            Map.of("field", "rights", "permission", value.getKey(),
                                    "allowed", "post_messages,invite_members,create_polls,"
                                            + "start_calls,pin_messages,change_info"));
                }
                if (value.getValue() == null) {
                    throw DomainException.badRequest("permission value is required",
                            Map.of("field", "rights", "permission", permission.wire()));
                }
                parsed.put(permission, value.getValue());
            }
            patch.put(role, parsed);
        }
        return patch;
    }

    /**
     * Read-only channels allow writing only to chat OWNER/ADMIN (ABAC-10). The caller still
     * checks the per-role permission row afterwards, so an ADMIN with
     * {@code post_messages=false} cannot write either.
     */
    public static boolean readOnlyManager(String role) {
        return canManage(role);
    }

    private static Map<ChatPermission, Boolean> all(boolean value) {
        return matrix(value, value, value, value, value, value);
    }

    private static Map<ChatPermission, Boolean> matrix(boolean post, boolean invite,
                                                       boolean polls, boolean calls,
                                                       boolean pin, boolean changeInfo) {
        Map<ChatPermission, Boolean> values = new EnumMap<>(ChatPermission.class);
        values.put(ChatPermission.POST_MESSAGES, post);
        values.put(ChatPermission.INVITE_MEMBERS, invite);
        values.put(ChatPermission.CREATE_POLLS, polls);
        values.put(ChatPermission.START_CALLS, calls);
        values.put(ChatPermission.PIN_MESSAGES, pin);
        values.put(ChatPermission.CHANGE_INFO, changeInfo);
        return Collections.unmodifiableMap(values);
    }
}
