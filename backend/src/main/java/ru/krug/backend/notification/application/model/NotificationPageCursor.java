package ru.krug.backend.notification.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import ru.krug.backend.notification.domain.exception.InvalidNotificationCursorException;

/**
 * Opaque base64url cursor for the stable {@code (created_at DESC, id DESC)} order.
 * Microsecond precision is preserved so rows created in the same millisecond never
 * produce duplicates or gaps across pages.
 */
public record NotificationPageCursor(Instant createdAt, UUID id) {

    private static final Pattern JSON =
            Pattern.compile("^\\{\"t\":(\\d{1,19}),\"id\":\"([0-9a-fA-F-]{36})\"\\}$");

    public NotificationPageCursor {
        if (createdAt == null || id == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(createdAt.getEpochSecond(), 1_000_000L),
                createdAt.getNano() / 1_000L);
        String json = "{\"t\":" + micros + ",\"id\":\"" + id + "\"}";
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    public static NotificationPageCursor decode(String value) {
        if (value == null || value.isBlank()) {
            throw new InvalidNotificationCursorException();
        }
        try {
            String json = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            Matcher matcher = JSON.matcher(json);
            if (!matcher.matches()) {
                throw new InvalidNotificationCursorException();
            }
            long micros = Long.parseLong(matcher.group(1));
            Instant instant = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new NotificationPageCursor(instant, UUID.fromString(matcher.group(2)));
        } catch (InvalidNotificationCursorException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new InvalidNotificationCursorException();
        }
    }
}
