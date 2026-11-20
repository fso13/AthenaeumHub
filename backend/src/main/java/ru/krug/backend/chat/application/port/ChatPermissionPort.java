package ru.krug.backend.chat.application.port;

import java.util.UUID;

import ru.krug.backend.chat.domain.model.ChatPermission;

/**
 * Cross-context permission gate for channel actions (P0-2 / #80). Implemented by the chat
 * context; called by message (send), plugin (poll create) and realtime (call offer) so the
 * configurable rights matrix and the read-only flag are enforced exactly once.
 *
 * <p>The caller must already have passed {@code ChatAccessPort.requireActiveChat}; this gate
 * re-resolves the ACTIVE participant row and the effective permission, and never trusts a
 * role supplied by the transport.</p>
 */
public interface ChatPermissionPort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException 404 when the chat or ACTIVE
     *         participant no longer exists, 403 {@code CHAT_READ_ONLY} for a write in a
     *         read-only channel, 403 {@code CHAT_PERMISSION_DENIED} when the role lacks the
     *         right.
     */
    void requireAllowed(UUID workspaceId, UUID chatId, UUID userId, ChatPermission permission);

    /**
     * Non-throwing variant for transports that cannot start a rollback-only transaction
     * (the WS call-signalling adapter). Same rules as {@link #requireAllowed}; a missing
     * chat/member is {@code false}.
     */
    boolean isAllowed(UUID workspaceId, UUID chatId, UUID userId, ChatPermission permission);
}
