package ru.krug.backend.message.application.model;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.domain.model.CryptoEnvelope;

/**
 * Result of device-aware envelope validation: the envelopes to store with the message, the
 * coverage to answer with, and the per-device wire payload for live {@code message.created}
 * fan-out. The last map is never persisted.
 */
public record E2eeSendPlan(List<CryptoEnvelope> envelopes, EnvelopeCoverageView coverage,
                           Map<UUID, Object> cryptoByDevice) {

    public E2eeSendPlan {
        envelopes = List.copyOf(envelopes);
        cryptoByDevice = Map.copyOf(cryptoByDevice);
    }
}
