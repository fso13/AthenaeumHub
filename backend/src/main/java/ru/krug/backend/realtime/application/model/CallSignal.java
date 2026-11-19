package ru.krug.backend.realtime.application.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Validated 1:1 call signalling payload. It is relayed verbatim and never persisted,
 * inspected, or logged: SDP and ICE candidates must never reach application logs.
 */
public record CallSignal(
        UUID callId,
        CallKind kind,
        boolean video,
        String sdp,
        Map<String, Object> candidate) {

    public CallSignal {
        Objects.requireNonNull(callId, "callId");
        Objects.requireNonNull(kind, "kind");
        candidate = candidate == null ? null
                : Collections.unmodifiableMap(new LinkedHashMap<>(candidate));
    }

    /** Redacted: a record's generated toString would leak SDP/candidates into any log. */
    @Override
    public String toString() {
        return "CallSignal[callId=" + callId + ", kind=" + kind + ", video=" + video
                + ", sdp=<redacted>, candidate=<redacted>]";
    }
}
