package ru.krug.backend.workspace.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceSecurityCursorException;

/**
 * Opaque base64url cursor for the workspace audit, DLP-event and session pages. It carries
 * the endpoint scope, the workspace id (a cursor cannot be replayed against another
 * workspace) and the last row's keyset {@code (timestamp, key)}. Microsecond precision is
 * preserved to match PostgreSQL {@code timestamptz}, so rows sharing a millisecond never
 * duplicate or skip. Fields are NUL-separated; the key is a UUID or a Keycloak session id.
 */
public record WorkspaceSecurityCursor(String scope, UUID workspaceId, Instant at, String key) {

    public static final String SCOPE_AUDIT = "ws_audit";
    public static final String SCOPE_DLP = "ws_dlp";
    public static final String SCOPE_SESSIONS = "ws_sessions";

    private static final String VERSION = "wsc1";
    private static final String SEPARATOR = "\u0000";
    private static final int MAX_KEY_LENGTH = 128;

    public WorkspaceSecurityCursor {
        if (scope == null || workspaceId == null || at == null || key == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
        if (!SCOPE_AUDIT.equals(scope) && !SCOPE_DLP.equals(scope)
                && !SCOPE_SESSIONS.equals(scope)) {
            throw new IllegalArgumentException("unsupported cursor scope");
        }
        if (key.isEmpty() || key.length() > MAX_KEY_LENGTH || key.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("cursor key is invalid");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(at.getEpochSecond(), 1_000_000L),
                at.getNano() / 1_000L);
        String raw = VERSION + SEPARATOR + scope + SEPARATOR + workspaceId + SEPARATOR
                + micros + SEPARATOR + key;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /** Decodes a cursor and rejects one issued for another endpoint or workspace. */
    public static WorkspaceSecurityCursor decode(String value, String expectedScope,
                                                 UUID expectedWorkspaceId) {
        if (value == null || value.isBlank() || expectedScope == null
                || expectedWorkspaceId == null) {
            throw new InvalidWorkspaceSecurityCursorException();
        }
        try {
            String raw = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            String[] parts = raw.split(SEPARATOR, -1);
            if (parts.length != 5 || !VERSION.equals(parts[0])
                    || !expectedScope.equals(parts[1])) {
                throw new InvalidWorkspaceSecurityCursorException();
            }
            UUID workspaceId = UUID.fromString(parts[2]);
            if (!workspaceId.equals(expectedWorkspaceId)) {
                throw new InvalidWorkspaceSecurityCursorException();
            }
            long micros = Long.parseLong(parts[3]);
            Instant at = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new WorkspaceSecurityCursor(parts[1], workspaceId, at, parts[4]);
        } catch (InvalidWorkspaceSecurityCursorException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new InvalidWorkspaceSecurityCursorException();
        }
    }
}
