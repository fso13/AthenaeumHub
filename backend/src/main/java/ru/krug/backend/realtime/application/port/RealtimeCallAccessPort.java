package ru.krug.backend.realtime.application.port;

import java.util.Set;
import java.util.UUID;

import ru.krug.backend.realtime.application.model.RealtimeCallAccess;

/**
 * Authorises call signalling and resolves the exact recipient set for one frame.
 *
 * <ul>
 *   <li>DIRECT: the caller must be an ACTIVE member; the recipient is the single other
 *       ACTIVE member. Conference metadata is rejected.</li>
 *   <li>GROUP: the caller must be an ACTIVE member; every requested recipient must be an
 *       ACTIVE member of the same chat, must not be the caller, and the list is required.</li>
 * </ul>
 *
 * <p>Implementations never throw for a denied chat so the transport can answer with a stable
 * error code without leaking chat existence or type.
 */
public interface RealtimeCallAccessPort {

    RealtimeCallAccess check(UUID workspaceId, UUID chatId, UUID userId, boolean conference,
                             Set<UUID> requestedRecipients, String requestId);
}
