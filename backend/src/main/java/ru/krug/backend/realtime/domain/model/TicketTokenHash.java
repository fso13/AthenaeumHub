package ru.krug.backend.realtime.domain.model;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * SHA-256 hash of the opaque ticket. Only the hash is persisted, so a database leak does
 * not expose usable tickets.
 */
public record TicketTokenHash(String value) {

    private static final Pattern HEX_256 = Pattern.compile("[0-9a-f]{64}");

    public TicketTokenHash {
        Objects.requireNonNull(value, "token hash");
        if (!HEX_256.matcher(value).matches()) {
            throw new IllegalArgumentException("token hash must be 64 lowercase hex characters");
        }
    }
}
