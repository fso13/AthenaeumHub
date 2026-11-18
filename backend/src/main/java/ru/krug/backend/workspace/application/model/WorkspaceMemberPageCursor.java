package ru.krug.backend.workspace.application.model;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceMemberCursorException;

/**
 * Opaque base64url cursor for the workspace member page. It carries a version, the
 * workspace id (a cursor cannot be replayed against another workspace) and the last row's
 * keyset {@code (display_name, user_id)}. Fields are separated by NUL, which PostgreSQL
 * {@code text} columns cannot contain, so display names with quotes/percent signs are
 * safe. The cursor is opaque, not a security boundary: it only selects the next keyset
 * position, and the database still enforces the caller's membership for every page.
 */
public record WorkspaceMemberPageCursor(UUID workspaceId, String displayName, UUID userId) {

    private static final String VERSION = "wmm1";
    private static final String SEPARATOR = "\u0000";

    public WorkspaceMemberPageCursor {
        if (workspaceId == null || displayName == null || userId == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
        if (displayName.isEmpty() || displayName.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("cursor display name is invalid");
        }
    }

    public String encode() {
        String raw = VERSION + SEPARATOR + workspaceId + SEPARATOR + displayName + SEPARATOR
                + userId;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /** Decodes a cursor and rejects one issued for a different workspace or endpoint. */
    public static WorkspaceMemberPageCursor decode(String value, UUID expectedWorkspaceId) {
        if (value == null || value.isBlank() || expectedWorkspaceId == null) {
            throw new InvalidWorkspaceMemberCursorException();
        }
        try {
            String raw = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            String[] parts = raw.split(SEPARATOR, -1);
            if (parts.length != 4 || !VERSION.equals(parts[0])) {
                throw new InvalidWorkspaceMemberCursorException();
            }
            UUID workspaceId = UUID.fromString(parts[1]);
            if (!workspaceId.equals(expectedWorkspaceId)) {
                throw new InvalidWorkspaceMemberCursorException();
            }
            return new WorkspaceMemberPageCursor(workspaceId, parts[2],
                    UUID.fromString(parts[3]));
        } catch (InvalidWorkspaceMemberCursorException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new InvalidWorkspaceMemberCursorException();
        }
    }
}
