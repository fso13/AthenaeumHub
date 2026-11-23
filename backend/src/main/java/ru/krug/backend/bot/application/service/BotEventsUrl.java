package ru.krug.backend.bot.application.service;

import java.net.URI;
import java.util.Locale;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Validation/normalisation of a bot event endpoint. Only an absolute {@code https} URL is
 * accepted; userinfo, query and fragment are rejected because they are the usual hiding
 * place for credentials and because the URL itself is stored in clear (unlike the signing
 * secret). The resolved-IP SSRF check happens at send time, never only here.
 */
public final class BotEventsUrl {

    public static final int MAX_LENGTH = 2048;

    private BotEventsUrl() {
    }

    /**
     * @param raw {@code null} means "not supplied"; a blank value clears the endpoint
     * @return the stripped URL, or {@code null} for a blank input
     * @throws DomainException 422 {@code BOT_EVENTS_URL_INVALID} for a malformed URL
     */
    public static String normalize(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.strip();
        if (value.isEmpty()) {
            return null;
        }
        if (value.length() > MAX_LENGTH) {
            throw invalid("url must be at most " + MAX_LENGTH + " characters");
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7F || Character.isWhitespace(character)) {
                throw invalid("url must not contain whitespace or control characters");
            }
        }
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException ex) {
            throw invalid("url is not a valid absolute URL");
        }
        String scheme = uri.getScheme();
        if (scheme == null || !"https".equals(scheme.toLowerCase(Locale.ROOT))) {
            throw invalid("url must use https");
        }
        if (uri.getHost() == null || uri.getHost().isBlank()) {
            throw invalid("url must contain a host");
        }
        if (uri.getUserInfo() != null) {
            throw invalid("url must not contain credentials");
        }
        if (uri.getQuery() != null || uri.getRawQuery() != null) {
            throw invalid("url must not contain a query string");
        }
        if (uri.getFragment() != null || uri.getRawFragment() != null) {
            throw invalid("url must not contain a fragment");
        }
        if (uri.getPort() == 0 || uri.getPort() < -1 || uri.getPort() > 65535) {
            throw invalid("url port is invalid");
        }
        String path = uri.getRawPath();
        if (path != null) {
            for (String segment : path.split("/", -1)) {
                if ("..".equals(segment) || ".".equals(segment)) {
                    throw invalid("url path must not contain dot segments");
                }
            }
        }
        return value;
    }

    private static DomainException invalid(String detail) {
        return DomainException.unprocessable(ErrorCode.BOT_EVENTS_URL_INVALID,
                "Bot events URL is invalid",
                Map.of("field", "events_url", "reason", detail));
    }
}
