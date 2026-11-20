package ru.krug.backend.message.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;

/**
 * Opaque base64url keyset cursor for {@code GET /me/mentions} over
 * {@code (created_at DESC, id DESC)}. Bound to the workspace and the unread filter so a
 * cursor from "all" cannot silently paginate an "unread" list.
 */
public record MentionPageCursor(UUID workspaceId, boolean unreadOnly, Instant createdAt,
                                UUID id) {

    private static final String VERSION = "mnp1";
    private static final String SEPARATOR = "\u0000";

    public MentionPageCursor {
        if (workspaceId == null || createdAt == null || id == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(createdAt.getEpochSecond(), 1_000_000L),
                createdAt.getNano() / 1_000L);
        String raw = VERSION + SEPARATOR + workspaceId + SEPARATOR + (unreadOnly ? "1" : "0")
                + SEPARATOR + micros + SEPARATOR + id;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    public static MentionPageCursor decode(String value, UUID expectedWorkspaceId,
                                           boolean expectedUnreadOnly) {
        if (value == null || value.isBlank() || expectedWorkspaceId == null) {
            throw invalid();
        }
        try {
            String raw = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            String[] parts = raw.split(SEPARATOR, -1);
            if (parts.length != 5 || !VERSION.equals(parts[0])) {
                throw invalid();
            }
            UUID workspaceId = UUID.fromString(parts[1]);
            boolean unreadOnly = "1".equals(parts[2]);
            if (!workspaceId.equals(expectedWorkspaceId)
                    || unreadOnly != expectedUnreadOnly) {
                throw invalid();
            }
            long micros = Long.parseLong(parts[3]);
            Instant createdAt = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new MentionPageCursor(workspaceId, unreadOnly, createdAt,
                    UUID.fromString(parts[4]));
        } catch (DomainException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw invalid();
        }
    }

    private static DomainException invalid() {
        return DomainException.badRequest("cursor is invalid for this mentions list",
                java.util.Map.of("field", "cursor"));
    }
}
