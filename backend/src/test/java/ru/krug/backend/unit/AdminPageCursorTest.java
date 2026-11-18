package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.application.model.AdminPageCursor;
import ru.krug.backend.ops.domain.exception.InvalidAdminCursorException;

/** Opaque admin cursor: microsecond round-trip, endpoint scope binding, bad input. */
class AdminPageCursorTest {

    @Test
    void roundTripsInstantWithMicrosecondPrecision() {
        Instant createdAt = Instant.parse("2026-05-17T10:20:30.123456Z");
        UUID id = UUID.randomUUID();
        AdminPageCursor cursor = new AdminPageCursor(AdminPageCursor.SCOPE_USERS, createdAt, id);

        String encoded = cursor.encode();
        assertThat(encoded).doesNotContain("=");

        AdminPageCursor decoded = AdminPageCursor.decode(encoded, AdminPageCursor.SCOPE_USERS);
        assertThat(decoded.scope()).isEqualTo(AdminPageCursor.SCOPE_USERS);
        assertThat(decoded.createdAt()).isEqualTo(createdAt);
        assertThat(decoded.id()).isEqualTo(id);
    }

    @Test
    void rejectsCursorIssuedForAnotherEndpoint() {
        String encoded = new AdminPageCursor(AdminPageCursor.SCOPE_USERS,
                Instant.now(), UUID.randomUUID()).encode();

        assertThatThrownBy(() -> AdminPageCursor.decode(encoded, AdminPageCursor.SCOPE_CHATS))
                .isInstanceOf(InvalidAdminCursorException.class);
    }

    @Test
    void rejectsMalformedCursor() {
        assertThatThrownBy(() -> AdminPageCursor.decode("not-a-cursor",
                AdminPageCursor.SCOPE_USERS)).isInstanceOf(InvalidAdminCursorException.class);
        assertThatThrownBy(() -> AdminPageCursor.decode("", AdminPageCursor.SCOPE_USERS))
                .isInstanceOf(InvalidAdminCursorException.class);
    }

    @Test
    void roundTripsTheAuditScopeAndBindsItToTheAuditEndpoint() {
        Instant createdAt = Instant.parse("2026-11-18T09:00:00.654321Z");
        UUID id = UUID.randomUUID();
        String encoded = new AdminPageCursor(AdminPageCursor.SCOPE_AUDIT, createdAt, id).encode();

        AdminPageCursor decoded = AdminPageCursor.decode(encoded, AdminPageCursor.SCOPE_AUDIT);
        assertThat(decoded.createdAt()).isEqualTo(createdAt);
        assertThat(decoded.id()).isEqualTo(id);

        assertThatThrownBy(() -> AdminPageCursor.decode(encoded, AdminPageCursor.SCOPE_USERS))
                .isInstanceOf(InvalidAdminCursorException.class);
        assertThatThrownBy(() -> AdminPageCursor.decode(encoded, AdminPageCursor.SCOPE_CHATS))
                .isInstanceOf(InvalidAdminCursorException.class);
    }
}
