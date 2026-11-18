package ru.krug.backend.ops.application.model;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import ru.krug.backend.ops.domain.exception.InvalidAdminCursorException;

/**
 * Opaque base64url cursor for the admin keyset pages. It carries the page scope
 * ({@code users}/{@code chats}/{@code audit}) plus the last row's
 * {@code (created_at, id)} key, so a cursor cannot be moved between endpoints.
 * Microsecond precision is preserved to match PostgreSQL {@code timestamptz}: rows sharing
 * a millisecond never duplicate or skip.
 */
public record AdminPageCursor(String scope, Instant createdAt, UUID id) {

    public static final String SCOPE_USERS = "users";
    public static final String SCOPE_CHATS = "chats";
    public static final String SCOPE_AUDIT = "audit";

    private static final Pattern JSON = Pattern.compile(
            "^\\{\"s\":\"(users|chats|audit)\",\"t\":(\\d{1,19}),"
                    + "\"id\":\"([0-9a-fA-F-]{36})\"\\}$");

    public AdminPageCursor {
        if (scope == null || createdAt == null || id == null) {
            throw new IllegalArgumentException("cursor fields are required");
        }
        if (!SCOPE_USERS.equals(scope) && !SCOPE_CHATS.equals(scope)
                && !SCOPE_AUDIT.equals(scope)) {
            throw new IllegalArgumentException("unsupported cursor scope");
        }
    }

    public String encode() {
        long micros = Math.addExact(Math.multiplyExact(createdAt.getEpochSecond(), 1_000_000L),
                createdAt.getNano() / 1_000L);
        String json = "{\"s\":\"" + scope + "\",\"t\":" + micros + ",\"id\":\"" + id + "\"}";
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    /** Decodes a cursor and rejects one that was issued for a different admin list. */
    public static AdminPageCursor decode(String value, String expectedScope) {
        if (value == null || value.isBlank()) {
            throw new InvalidAdminCursorException();
        }
        try {
            String json = new String(Base64.getUrlDecoder().decode(value),
                    StandardCharsets.UTF_8);
            Matcher matcher = JSON.matcher(json);
            if (!matcher.matches() || !matcher.group(1).equals(expectedScope)) {
                throw new InvalidAdminCursorException();
            }
            long micros = Long.parseLong(matcher.group(2));
            Instant instant = Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L),
                    Math.floorMod(micros, 1_000_000L) * 1_000L);
            return new AdminPageCursor(matcher.group(1), instant,
                    UUID.fromString(matcher.group(3)));
        } catch (InvalidAdminCursorException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new InvalidAdminCursorException();
        }
    }
}
