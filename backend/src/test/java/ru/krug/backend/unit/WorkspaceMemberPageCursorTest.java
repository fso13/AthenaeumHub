package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.workspace.application.model.WorkspaceMemberPageCursor;
import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceMemberCursorException;

/** E10-B opaque member cursor: round-trip, workspace binding and tamper rejection. */
class WorkspaceMemberPageCursorTest {

    private final UUID workspaceId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();

    @Test
    void roundTripsUnicodeAndSpecialCharacters() {
        String displayName = "Иван \"%_\\\n\tДмитрий";
        WorkspaceMemberPageCursor cursor = new WorkspaceMemberPageCursor(workspaceId,
                displayName, userId);

        WorkspaceMemberPageCursor decoded = WorkspaceMemberPageCursor.decode(cursor.encode(),
                workspaceId);

        assertThat(decoded).isEqualTo(cursor);
        assertThat(decoded.displayName()).isEqualTo(displayName);
    }

    @Test
    void encodedCursorIsUrlSafeWithoutPadding() {
        String encoded = new WorkspaceMemberPageCursor(workspaceId, "name", userId).encode();

        assertThat(encoded).doesNotContain("=").doesNotContain("+").doesNotContain("/");
    }

    @Test
    void rejectsCursorIssuedForAnotherWorkspace() {
        String encoded = new WorkspaceMemberPageCursor(workspaceId, "name", userId).encode();

        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode(encoded, UUID.randomUUID()))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);
    }

    @Test
    void rejectsGarbageWrongVersionAndMalformedPayloads() {
        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode("garbage", workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);
        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode(null, workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);
        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode(" ", workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);

        String wrongVersion = base64("wmm2\u0000" + workspaceId + "\u0000name\u0000" + userId);
        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode(wrongVersion, workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);

        String wrongParts = base64("wmm1\u0000" + workspaceId + "\u0000name");
        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode(wrongParts, workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);

        String badId = base64("wmm1\u0000" + workspaceId + "\u0000name\u0000not-a-uuid");
        assertThatThrownBy(() -> WorkspaceMemberPageCursor.decode(badId, workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);
    }

    @Test
    void rejectsInvalidConstructorInput() {
        assertThatThrownBy(() -> new WorkspaceMemberPageCursor(workspaceId, "", userId))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceMemberPageCursor(workspaceId, "a\u0000b", userId))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceMemberPageCursor(null, "name", userId))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static String base64(String raw) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }
}
