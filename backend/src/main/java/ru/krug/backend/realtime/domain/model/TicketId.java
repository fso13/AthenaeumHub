package ru.krug.backend.realtime.domain.model;

import java.util.Objects;
import java.util.UUID;

/** Identity of a one-time realtime ticket. */
public record TicketId(UUID value) {

    public TicketId {
        Objects.requireNonNull(value, "ticket id");
    }

    public static TicketId newId() {
        return new TicketId(UUID.randomUUID());
    }
}
