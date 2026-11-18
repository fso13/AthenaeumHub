package ru.krug.backend.realtime.application.port;

import java.util.UUID;

import ru.krug.backend.realtime.application.model.RealtimeChatAccess;

/**
 * Membership gate for WS subscriptions. Implementations must never throw for a denied
 * chat: they return {@code accepted=false} so the transport can answer
 * {@code accepted:false, reason:"FORBIDDEN"} without leaking chat existence.
 */
public interface RealtimeChatAccessPort {

    RealtimeChatAccess check(UUID workspaceId, UUID chatId, UUID userId, String requestId);
}
