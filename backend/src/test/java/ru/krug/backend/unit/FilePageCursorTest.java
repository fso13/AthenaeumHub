package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.application.model.FilePageCursor;
import ru.krug.backend.file.domain.exception.InvalidFileCursorException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** #73 opaque cursor: stable microsecond keyset, workspace-bound, tamper -> 400. */
class FilePageCursorTest {

    private static final UUID WORKSPACE = UUID.randomUUID();

    @Test
    void roundTripsMicrosecondTimestampAndId() {
        Instant createdAt = Instant.ofEpochSecond(1_730_000_000L, 123_456_000L);
        UUID id = UUID.randomUUID();

        String encoded = new FilePageCursor(WORKSPACE, createdAt, id).encode();
        assertThat(encoded).doesNotContain("+").doesNotContain("/").doesNotContain("=");

        FilePageCursor decoded = FilePageCursor.decode(encoded, WORKSPACE);
        assertThat(decoded.workspaceId()).isEqualTo(WORKSPACE);
        assertThat(decoded.createdAt()).isEqualTo(createdAt);
        assertThat(decoded.id()).isEqualTo(id);
    }

    @Test
    void preservesTheTieBreakerAcrossPages() {
        Instant sameInstant = Instant.ofEpochSecond(1_730_000_001L, 999_000L);
        UUID lower = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID higher = UUID.fromString("ffffffff-ffff-ffff-ffff-ffffffffffff");

        assertThat(FilePageCursor.decode(
                new FilePageCursor(WORKSPACE, sameInstant, higher).encode(), WORKSPACE).id())
                .isEqualTo(higher);
        assertThat(FilePageCursor.decode(
                new FilePageCursor(WORKSPACE, sameInstant, lower).encode(), WORKSPACE).id())
                .isEqualTo(lower);
    }

    @Test
    void rejectsMalformedOrForeignCursors() {
        UUID otherWorkspace = UUID.randomUUID();
        String foreign = new FilePageCursor(otherWorkspace, Instant.now(), UUID.randomUUID())
                .encode();

        assertInvalid(null, WORKSPACE);
        assertInvalid("   ", WORKSPACE);
        assertInvalid("not-base64", WORKSPACE);
        assertInvalid(foreign, WORKSPACE);
        assertInvalid("fcp1", WORKSPACE);
        assertInvalid(new FilePageCursor(WORKSPACE, Instant.now(), UUID.randomUUID()).encode(),
                otherWorkspace);
    }

    private void assertInvalid(String cursor, UUID workspaceId) {
        assertThatThrownBy(() -> FilePageCursor.decode(cursor, workspaceId))
                .isInstanceOf(InvalidFileCursorException.class)
                .satisfies(ex -> {
                    InvalidFileCursorException domain = (InvalidFileCursorException) ex;
                    assertThat(domain.category()).isEqualTo(ErrorCategory.BAD_REQUEST);
                    assertThat(domain.code()).isEqualTo(ErrorCode.VALIDATION_FAILED);
                    assertThat(domain.details()).containsEntry("field", "cursor");
                });
    }
}
