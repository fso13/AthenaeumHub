package ru.krug.backend.chat.domain.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Installation chat limits (FR-CHAT-15/16). Pure domain rule: the caller passes the
 * server-side counters read in the same transaction as the insert. Exceeding either limit
 * is a {@code 409 CHAT_LIMIT_REACHED} with {@code details.scope/limit/used}.
 */
public final class ChatLimitPolicy {

    public static final String SCOPE_USER = "USER";
    public static final String SCOPE_WORKSPACE = "WORKSPACE";

    private ChatLimitPolicy() {
    }

    public static void requireUserCapacity(long used, int limit) {
        requireCapacity(SCOPE_USER, used, limit);
    }

    public static void requireWorkspaceCapacity(long used, int limit) {
        requireCapacity(SCOPE_WORKSPACE, used, limit);
    }

    private static void requireCapacity(String scope, long used, int limit) {
        if (used >= limit) {
            throw DomainException.conflict(ErrorCode.CHAT_LIMIT_REACHED,
                    "Chat limit reached", Map.of(
                            "scope", scope,
                            "limit", limit,
                            "used", used));
        }
    }
}
