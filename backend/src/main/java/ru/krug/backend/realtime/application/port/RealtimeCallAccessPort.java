package ru.krug.backend.realtime.application.port;

import java.util.UUID;

import ru.krug.backend.realtime.application.model.RealtimeCallAccess;

/**
 * Authorises call signalling: the caller must be an ACTIVE member of a live DIRECT chat.
 * Implementations never throw for a denied chat so the transport can answer with a stable
 * error code without leaking chat existence or type.
 */
public interface RealtimeCallAccessPort {

    RealtimeCallAccess check(UUID workspaceId, UUID chatId, UUID userId, String requestId);
}
