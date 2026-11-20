package ru.krug.backend.ops.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import ru.krug.backend.ops.domain.exception.InvalidAdminCursorException;

/**
 * Opaque cursor for {@code GET /admin/sessions}. It is bound to the selected local user id
 * (a cursor cannot be replayed for a different user) and carries the last row's
 * {@code (last_seen_at, session_id)} keyset at microsecond precision.
 */
public record AdminSessionCursor(String scope, UUID userId, Instant at, String sessionId) {

    public static final String SCOPE = "admin_sessions";
    private static final String VERSION = "asc1";
    private static final String SEPARATOR = "\u0000";
    private static final int MAX_SESSION_ID_LENGTH = 128;

    public AdminSessionCursor {
        if (scope == null || userId == null || at == null || sessionId == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
        if (!SCOPE.equals(scope)) {
            throw new IllegalArgumentException("unsupported cursor scope");
        }
        if (sessionId.isEmpty() || sessionId.length() > MAX_SESSION_ID_LENGTH
                || sessionId.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("cursor session id is invalid");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(at.getEpochSecond(), 1_000_000L),
                at.getNano() / 1_000L);
        String raw = VERSION + SEPARATOR + scope + SEPARATOR + userId + SEPARATOR
                + micros + SEPARATOR + sessionId;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    public static AdminSessionCursor decode(String value, UUID expectedUserId) {
        if (value == null || value.isBlank() || expectedUserId == null) {
            throw new InvalidAdminCursorException();
        }
        try {
            String raw = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            String[] parts = raw.split(SEPARATOR, -1);
            if (parts.length != 5 || !VERSION.equals(parts[0]) || !SCOPE.equals(parts[1])) {
                throw new InvalidAdminCursorException();
            }
            UUID userId = UUID.fromString(parts[2]);
            if (!userId.equals(expectedUserId)) {
                throw new InvalidAdminCursorException();
            }
            long micros = Long.parseLong(parts[3]);
            Instant at = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new AdminSessionCursor(parts[1], userId, at, parts[4]);
        } catch (InvalidAdminCursorException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new InvalidAdminCursorException();
        }
    }
}
