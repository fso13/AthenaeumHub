package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.application.model.AdminSessionCursor;
import ru.krug.backend.ops.domain.exception.InvalidAdminCursorException;

/** Encode/decode and user-binding of the platform-admin session cursor. */
class AdminSessionCursorTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID OTHER_USER_ID = UUID.randomUUID();
    private static final Instant AT = Instant.parse("2026-11-20T10:00:00.123456Z");

    @Test
    void roundTripsWithMicrosecondPrecision() {
        AdminSessionCursor cursor = new AdminSessionCursor(AdminSessionCursor.SCOPE, USER_ID,
                AT, "session-1");
        AdminSessionCursor decoded = AdminSessionCursor.decode(cursor.encode(), USER_ID);
        assertThat(decoded).isEqualTo(cursor);
    }

    @Test
    void rejectsCursorForAnotherUser() {
        AdminSessionCursor cursor = new AdminSessionCursor(AdminSessionCursor.SCOPE, USER_ID,
                AT, "session-1");
        assertThatThrownBy(() -> AdminSessionCursor.decode(cursor.encode(), OTHER_USER_ID))
                .isInstanceOf(InvalidAdminCursorException.class);
    }

    @Test
    void rejectsMalformedCursor() {
        assertThatThrownBy(() -> AdminSessionCursor.decode("garbage", USER_ID))
                .isInstanceOf(InvalidAdminCursorException.class);
        assertThatThrownBy(() -> AdminSessionCursor.decode(null, USER_ID))
                .isInstanceOf(InvalidAdminCursorException.class);
    }

    @Test
    void rejectsOverlongSessionId() {
        assertThatThrownBy(() -> new AdminSessionCursor(AdminSessionCursor.SCOPE, USER_ID,
                AT, "x".repeat(129))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdminSessionCursor(AdminSessionCursor.SCOPE, USER_ID,
                AT, "bad\u0000id")).isInstanceOf(IllegalArgumentException.class);
    }
}
