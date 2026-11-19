package ru.krug.backend.file.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import ru.krug.backend.file.domain.exception.InvalidFileCursorException;

/**
 * Opaque base64url cursor for the stable {@code (created_at DESC, id DESC)} file-center
 * order. The payload is versioned, workspace-bound (a cursor cannot be replayed against
 * another workspace) and carries microsecond timestamps so rows created in the same
 * millisecond never produce duplicates or gaps across pages.
 *
 * <p>Fields are separated by NUL, which PostgreSQL {@code text} values and UUIDs cannot
 * contain. The cursor is not a security boundary: it only selects the next keyset position
 * and the database still enforces workspace/chat membership for every page.
 */
public record FilePageCursor(UUID workspaceId, Instant createdAt, UUID id) {

    private static final String VERSION = "fcp1";
    private static final String SEPARATOR = "\u0000";

    public FilePageCursor {
        if (workspaceId == null || createdAt == null || id == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(createdAt.getEpochSecond(), 1_000_000L),
                createdAt.getNano() / 1_000L);
        String raw = VERSION + SEPARATOR + workspaceId + SEPARATOR + micros + SEPARATOR + id;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /** Decodes a cursor and rejects one issued for a different workspace or endpoint. */
    public static FilePageCursor decode(String value, UUID expectedWorkspaceId) {
        if (value == null || value.isBlank() || expectedWorkspaceId == null) {
            throw new InvalidFileCursorException();
        }
        try {
            String raw = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            String[] parts = raw.split(SEPARATOR, -1);
            if (parts.length != 4 || !VERSION.equals(parts[0])) {
                throw new InvalidFileCursorException();
            }
            UUID workspaceId = UUID.fromString(parts[1]);
            if (!workspaceId.equals(expectedWorkspaceId)) {
                throw new InvalidFileCursorException();
            }
            long micros = Long.parseLong(parts[2]);
            Instant createdAt = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new FilePageCursor(workspaceId, createdAt, UUID.fromString(parts[3]));
        } catch (InvalidFileCursorException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new InvalidFileCursorException();
        }
    }
}
