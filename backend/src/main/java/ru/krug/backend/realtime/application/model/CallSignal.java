package ru.krug.backend.realtime.application.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Validated call signalling payload for DIRECT (1:1) and GROUP (mesh conference) chats.
 *
 * <p>A DIRECT frame carries no conference metadata: {@code conference=false} and an empty
 * {@code recipients} list, so the relayed frame stays byte-compatible with the 1:1 protocol.
 * A GROUP frame carries {@code conference=true} plus the explicit, non-empty recipient list;
 * the server fans out only to those users' live sessions and never echoes to the caller.
 *
 * <p>It is relayed verbatim and never persisted, inspected, or logged: SDP and ICE candidates
 * must never reach application logs.
 */
public record CallSignal(
        UUID callId,
        CallKind kind,
        boolean video,
        String sdp,
        Map<String, Object> candidate,
        boolean conference,
        List<UUID> recipients) {

    /** Protocol hard limit for a single GROUP signalling frame. */
    public static final int MAX_RECIPIENTS = 50;

    public CallSignal {
        Objects.requireNonNull(callId, "callId");
        Objects.requireNonNull(kind, "kind");
        candidate = candidate == null ? null
                : Collections.unmodifiableMap(new LinkedHashMap<>(candidate));
        recipients = recipients == null ? List.of() : List.copyOf(recipients);
        if (conference && recipients.isEmpty()) {
            throw new IllegalArgumentException("conference requires at least one recipient");
        }
        if (!conference && !recipients.isEmpty()) {
            throw new IllegalArgumentException("recipients are only valid for a conference");
        }
        if (recipients.size() > MAX_RECIPIENTS) {
            throw new IllegalArgumentException(
                    "recipients must not exceed " + MAX_RECIPIENTS);
        }
        if (new LinkedHashSet<>(recipients).size() != recipients.size()) {
            throw new IllegalArgumentException("recipients must not contain duplicates");
        }
    }

    /** DIRECT-compatible constructor: no conference metadata. */
    public CallSignal(UUID callId, CallKind kind, boolean video, String sdp,
                      Map<String, Object> candidate) {
        this(callId, kind, video, sdp, candidate, false, List.of());
    }

    /** Redacted: a record's generated toString would leak SDP/candidates into any log. */
    @Override
    public String toString() {
        return "CallSignal[callId=" + callId + ", kind=" + kind + ", video=" + video
                + ", conference=" + conference + ", recipients=" + recipients.size()
                + ", sdp=<redacted>, candidate=<redacted>]";
    }
}
