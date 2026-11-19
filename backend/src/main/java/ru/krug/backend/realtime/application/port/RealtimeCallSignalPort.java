package ru.krug.backend.realtime.application.port;

import ru.krug.backend.realtime.application.model.CallSignalRelay;

/**
 * Ephemeral fan-out for 1:1 call signalling. Delivery targets live sessions of the other
 * DIRECT-chat member only; nothing is persisted, replayed, or queued for offline peers.
 */
public interface RealtimeCallSignalPort {

    /**
     * @param relay             validated signal and its recipients
     * @param excludeSessionId  the sender's own session, never a recipient
     * @return number of peer sessions the frame was enqueued to (0 = peer offline);
     *         a best-effort count, not a delivery acknowledgement
     */
    int relay(CallSignalRelay relay, String excludeSessionId);
}
