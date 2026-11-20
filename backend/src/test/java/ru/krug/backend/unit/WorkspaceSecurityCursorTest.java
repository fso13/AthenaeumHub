package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.workspace.application.model.WorkspaceSecurityCursor;
import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceSecurityCursorException;

/** Opaque cursor contract for the P0-3 audit/DLP/session pages. */
class WorkspaceSecurityCursorTest {

    private static final UUID WORKSPACE_ID = UUID.randomUUID();

    @Test
    void roundTripsMicrosecondsScopeAndWorkspace() {
        Instant at = Instant.parse("2026-11-20T10:15:30.123456Z");
        String key = UUID.randomUUID().toString();
        WorkspaceSecurityCursor cursor = new WorkspaceSecurityCursor(
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID, at, key);

        WorkspaceSecurityCursor decoded = WorkspaceSecurityCursor.decode(cursor.encode(),
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID);

        assertThat(decoded.at()).isEqualTo(at);
        assertThat(decoded.scope()).isEqualTo(WorkspaceSecurityCursor.SCOPE_AUDIT);
        assertThat(decoded.workspaceId()).isEqualTo(WORKSPACE_ID);
        assertThat(decoded.key()).isEqualTo(key);
    }

    @Test
    void supportsTheSessionKeyFormat() {
        String key = "0f7e1c9a-5f1c-4a2e-9c7e-7a2a9a9d4e11";
        WorkspaceSecurityCursor cursor = new WorkspaceSecurityCursor(
                WorkspaceSecurityCursor.SCOPE_SESSIONS, WORKSPACE_ID, Instant.now(), key);
        assertThat(WorkspaceSecurityCursor.decode(cursor.encode(),
                WorkspaceSecurityCursor.SCOPE_SESSIONS, WORKSPACE_ID).key()).isEqualTo(key);
    }

    @Test
    void rejectsAnotherScopeOrWorkspace() {
        String encoded = new WorkspaceSecurityCursor(WorkspaceSecurityCursor.SCOPE_DLP,
                WORKSPACE_ID, Instant.now(), UUID.randomUUID().toString()).encode();

        assertThatThrownBy(() -> WorkspaceSecurityCursor.decode(encoded,
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID))
                .isInstanceOf(InvalidWorkspaceSecurityCursorException.class);
        assertThatThrownBy(() -> WorkspaceSecurityCursor.decode(encoded,
                WorkspaceSecurityCursor.SCOPE_DLP, UUID.randomUUID()))
                .isInstanceOf(InvalidWorkspaceSecurityCursorException.class);
    }

    @Test
    void rejectsGarbageAndTamperedKeys() {
        assertThatThrownBy(() -> WorkspaceSecurityCursor.decode("not-base64",
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID))
                .isInstanceOf(InvalidWorkspaceSecurityCursorException.class);
        assertThatThrownBy(() -> WorkspaceSecurityCursor.decode(null,
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID))
                .isInstanceOf(InvalidWorkspaceSecurityCursorException.class);
    }

    @Test
    void rejectsAnOverlongOrControlKey() {
        assertThatThrownBy(() -> new WorkspaceSecurityCursor(
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID, Instant.now(), "x".repeat(129)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceSecurityCursor(
                WorkspaceSecurityCursor.SCOPE_AUDIT, WORKSPACE_ID, Instant.now(), "a\u0000b"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
