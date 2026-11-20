package ru.krug.backend.message.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;

/**
 * Opaque base64url cursor for the server-side message search (#83).
 *
 * <p>It carries the last <b>scanned candidate</b> position, not the last hit: because the
 * body is AES-GCM at rest, matching happens in the application, so a page may legitimately
 * contain fewer hits than the scan window. Advancing on candidates guarantees that repeated
 * pages never loop on the same empty window. The payload is versioned and bound to the
 * workspace, the chat filter and the normalized query, so a cursor cannot silently mix two
 * different searches.
 */
public record MessageSearchCursor(
        UUID workspaceId,
        String query,
        UUID chatId,
        Instant createdAt,
        UUID id) {

    private static final String VERSION = "msp1";
    private static final String SEPARATOR = "\u0000";
    private static final String NONE = "-";

    public MessageSearchCursor {
        if (workspaceId == null || createdAt == null || id == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(createdAt.getEpochSecond(), 1_000_000L),
                createdAt.getNano() / 1_000L);
        String raw = VERSION + SEPARATOR + workspaceId + SEPARATOR
                + (query == null ? NONE : query) + SEPARATOR
                + (chatId == null ? NONE : chatId) + SEPARATOR + micros + SEPARATOR + id;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /** Decodes and verifies the workspace/query/chat binding of the cursor. */
    public static MessageSearchCursor decode(String value, UUID expectedWorkspaceId,
                                             String expectedQuery, UUID expectedChatId) {
        if (value == null || value.isBlank() || expectedWorkspaceId == null) {
            throw invalid();
        }
        try {
            String raw = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            String[] parts = raw.split(SEPARATOR, -1);
            if (parts.length != 6 || !VERSION.equals(parts[0])) {
                throw invalid();
            }
            UUID workspaceId = UUID.fromString(parts[1]);
            String query = NONE.equals(parts[2]) ? null : parts[2];
            UUID chatId = NONE.equals(parts[3]) ? null : UUID.fromString(parts[3]);
            if (!workspaceId.equals(expectedWorkspaceId)
                    || !java.util.Objects.equals(query, expectedQuery)
                    || !java.util.Objects.equals(chatId, expectedChatId)) {
                throw invalid();
            }
            long micros = Long.parseLong(parts[4]);
            Instant createdAt = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new MessageSearchCursor(workspaceId, query, chatId, createdAt,
                    UUID.fromString(parts[5]));
        } catch (DomainException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw invalid();
        }
    }

    private static DomainException invalid() {
        return DomainException.badRequest("cursor is invalid or belongs to another search",
                java.util.Map.of("field", "cursor"));
    }
}
