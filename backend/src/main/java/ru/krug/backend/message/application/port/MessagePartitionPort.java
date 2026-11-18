package ru.krug.backend.message.application.port;

import java.time.YearMonth;

/**
 * Ensures the monthly partition for a message timeline month exists (idempotent).
 */
public interface MessagePartitionPort {

    void ensureMonth(YearMonth month);
}
