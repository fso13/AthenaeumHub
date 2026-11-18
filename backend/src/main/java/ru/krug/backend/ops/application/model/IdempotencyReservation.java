package ru.krug.backend.ops.application.model;

import java.util.UUID;

/**
 * Outcome of reserving an Idempotency-Key. Replay is resolved by the owning context from
 * the immutable resource id (message), so no serialized response body is stored.
 */
public record IdempotencyReservation(boolean replay, int status, UUID resourceId) {

    public static IdempotencyReservation acquired() {
        return new IdempotencyReservation(false, 0, null);
    }

    public static IdempotencyReservation replay(int status, UUID resourceId) {
        return new IdempotencyReservation(true, status, resourceId);
    }
}
