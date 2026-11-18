package ru.krug.backend.shared.application.port;

import java.time.Instant;

/**
 * Application-owned clock. Implemented in infrastructure so time is replaceable in tests.
 */
public interface ClockPort {

    Instant now();
}
