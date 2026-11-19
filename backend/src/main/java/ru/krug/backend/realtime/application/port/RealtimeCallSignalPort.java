package ru.krug.backend.realtime.application.port;

import ru.krug.backend.realtime.application.model.CallSignalRelay;

/**
 * Ephemeral fan-out for DIRECT and GROUP call signalling. Delivery targets only the live
 * sessions of the recipients resolved by the access gate: nothing is persisted, replayed,
 * queued for offline recipients, or fanned out to users the caller did not name.
 */
public interface RealtimeCallSignalPort {

    /**
     * @param relay             validated signal and its exact recipient user ids
     * @param excludeSessionId  the sender's own session, never a recipient
     * @return number of recipient sessions the frame was enqueued to (0 = every recipient
     *         offline); a best-effort count, not a delivery acknowledgement
     */
    int relay(CallSignalRelay relay, String excludeSessionId);
}
