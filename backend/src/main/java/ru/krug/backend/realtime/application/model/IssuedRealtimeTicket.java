package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.Objects;

/** Result of issuing a ticket. The raw token is returned exactly once. */
public record IssuedRealtimeTicket(String ticket, Instant expiresAt, String wsUrl) {

    public IssuedRealtimeTicket {
        Objects.requireNonNull(ticket, "ticket");
        Objects.requireNonNull(expiresAt, "expiresAt");
        Objects.requireNonNull(wsUrl, "wsUrl");
    }
}
