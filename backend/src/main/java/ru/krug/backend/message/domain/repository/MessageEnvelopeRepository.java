package ru.krug.backend.message.domain.repository;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.domain.model.MessageEnvelope;

/**
 * Opaque per-recipient-device envelopes (§4.3). Reads are always scoped to one recipient
 * device: the server never returns the envelopes of another device, even to the same user.
 */
public interface MessageEnvelopeRepository {

    void saveAll(List<MessageEnvelope> envelopes);

    /** Envelopes addressed to {@code recipientDeviceId}, keyed by message id. */
    Map<UUID, MessageEnvelope> findForDevice(UUID workspaceId, Collection<UUID> messageIds,
                                             UUID recipientDeviceId);

    /** All envelopes of one message (internal use only, e.g. idempotent replay equality). */
    List<MessageEnvelope> findByMessage(UUID workspaceId, UUID messageId);
}
