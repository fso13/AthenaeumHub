package ru.krug.backend.ops.domain.model;

import java.util.UUID;

/**
 * Result of {@code ops.admin_set_user_status}. {@code outcome} makes the 404/409 decision
 * explicit instead of relying on a SQL exception mapping.
 */
public record AdminUserStatusChange(Outcome outcome, UUID id, String status) {

    public enum Outcome {
        OK,
        NOT_FOUND,
        ALREADY,
        LAST_ADMIN
    }

    public static Outcome outcome(String raw) {
        try {
            return Outcome.valueOf(raw);
        } catch (RuntimeException ex) {
            throw new IllegalStateException("Unexpected admin status outcome: " + raw, ex);
        }
    }

    public boolean ok() {
        return outcome == Outcome.OK;
    }
}
