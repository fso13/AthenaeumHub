package ru.krug.backend.room.domain.model;

import java.time.Duration;
import java.time.Instant;

/**
 * Presence is intentionally ephemeral and REST-based: the frontend sends a heartbeat every
 * 5 seconds and every read filters on {@code last_seen_at > cutoff}. There is no websocket
 * presence channel and no durable online flag.
 */
public final class RoomPresencePolicy {

    /** A participant is present while {@code last_seen_at} is within this window. */
    public static final Duration TTL = Duration.ofSeconds(30);

    private RoomPresencePolicy() {
    }

    public static Instant cutoff(Instant now) {
        return now.minus(TTL);
    }
}
