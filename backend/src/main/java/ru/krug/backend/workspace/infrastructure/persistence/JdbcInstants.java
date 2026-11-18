package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;

/**
 * PostgreSQL {@code timestamptz} arrives as {@link OffsetDateTime} through Hibernate 6
 * native queries; other JDBC layers may hand back {@link Timestamp}/{@link Instant}.
 * {@code LocalDateTime} is interpreted as UTC (the database session timezone).
 */
final class JdbcInstants {

    private JdbcInstants() {
    }

    static Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof OffsetDateTime offset) {
            return offset.toInstant();
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof LocalDateTime local) {
            return local.toInstant(ZoneOffset.UTC);
        }
        throw new IllegalStateException("Unexpected timestamptz type: "
                + value.getClass().getName());
    }
}
