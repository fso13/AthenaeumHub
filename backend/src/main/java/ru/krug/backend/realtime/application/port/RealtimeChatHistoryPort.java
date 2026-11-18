package ru.krug.backend.realtime.application.port;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.realtime.application.model.MessageSnapshot;

/**
 * Bounded history read for replay: messages with {@code seq > afterSeq} ordered by seq ASC.
 * The caller enforces the 500-message window; implementations must apply the limit.
 * {@code deviceId} scopes E2EE envelopes: a frame may only carry the envelope of the
 * connection's device.
 */
public interface RealtimeChatHistoryPort {

    List<MessageSnapshot> after(UUID workspaceId, UUID chatId, UUID userId, UUID deviceId,
                                long afterSeq, int limit);
}
