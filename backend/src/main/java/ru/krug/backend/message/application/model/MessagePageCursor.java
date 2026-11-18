package ru.krug.backend.message.application.model;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Opaque base64url message cursor: {"seq":N}. The client passes the seq back as
 * after_seq (ascending pages) or before_seq (descending pages).
 */
public record MessagePageCursor(long seq) {

    private static final Pattern JSON = Pattern.compile("^\\{\"seq\":(\\d{1,18})\\}$");

    public String encode() {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(("{\"seq\":" + seq + "}").getBytes(StandardCharsets.UTF_8));
    }

    public static MessagePageCursor decode(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("cursor is blank");
        }
        String json;
        try {
            json = new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("cursor is not valid base64url", ex);
        }
        Matcher matcher = JSON.matcher(json);
        if (!matcher.matches()) {
            throw new IllegalArgumentException("cursor payload is invalid");
        }
        return new MessagePageCursor(Long.parseLong(matcher.group(1)));
    }
}
