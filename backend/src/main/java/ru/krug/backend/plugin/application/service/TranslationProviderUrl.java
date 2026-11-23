package ru.krug.backend.plugin.application.service;

import java.net.URI;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Validation/normalisation of the administrator-supplied translation provider URL.
 *
 * <p>An absolute {@code https} URL is always accepted. A plain {@code http} URL is accepted
 * only for an internally reachable host — a single-label Docker/compose service name
 * ({@code libretranslate}), {@code localhost}, {@code *.local}/{@code *.internal} or a
 * loopback/RFC 1918/link-local address. That is the self-hosted LibreTranslate case; a
 * public plaintext provider is rejected. An optional path is allowed; userinfo, query and
 * fragment are rejected because they are the usual hiding place for credentials and API
 * keys, and the contract deliberately stores no secret. A literal URL is never logged or
 * echoed in an error message.</p>
 */
public final class TranslationProviderUrl {

    public static final int MAX_LENGTH = 2048;

    private static final Pattern IPV4 =
            Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");

    private TranslationProviderUrl() {
    }

    /**
     * @param raw {@code null} means "not supplied", an empty/blank value clears the URL
     * @return the stripped URL, or empty for a blank input
     * @throws DomainException 422 {@code TRANSLATION_URL_INVALID} for a malformed URL
     */
    public static String normalize(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.strip();
        if (value.isEmpty()) {
            return "";
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
        String normalizedScheme = scheme == null ? "" : scheme.toLowerCase(Locale.ROOT);
        if (!"https".equals(normalizedScheme) && !"http".equals(normalizedScheme)) {
            throw invalid("url must use https or an internal http host");
        }
        if (uri.getHost() == null || uri.getHost().isBlank()) {
            throw invalid("url must contain a host");
        }
        if ("http".equals(normalizedScheme) && !internalHost(uri.getHost())) {
            throw invalid("url must use https or an internal http host");
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

    /**
     * Non-throwing policy check used by the adapter on every call, so a hand-edited
     * environment value cannot bypass the URL policy.
     */
    public static boolean isSupported(String raw) {
        try {
            normalize(raw);
            return true;
        } catch (DomainException ex) {
            return false;
        }
    }

    /**
     * True for hosts that cannot be reached from the public internet: Docker/compose
     * single-label service names, loopback, RFC 1918, link-local and the common internal
     * TLDs. A plain {@code http} provider outside this set is rejected.
     */
    static boolean internalHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String value = host.toLowerCase(Locale.ROOT);
        if (value.startsWith("[") && value.endsWith("]")) {
            value = value.substring(1, value.length() - 1);
        }
        if ("localhost".equals(value) || "::1".equals(value)
                || "0:0:0:0:0:0:0:1".equals(value)) {
            return true;
        }
        if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) {
            return true;
        }
        if (value.endsWith(".localhost") || value.endsWith(".local")
                || value.endsWith(".internal") || value.endsWith(".lan")
                || value.endsWith(".home.arpa")) {
            return true;
        }
        Matcher ipv4 = IPV4.matcher(value);
        if (ipv4.matches()) {
            int first = Integer.parseInt(ipv4.group(1));
            int second = Integer.parseInt(ipv4.group(2));
            int third = Integer.parseInt(ipv4.group(3));
            int fourth = Integer.parseInt(ipv4.group(4));
            if (first > 255 || second > 255 || third > 255 || fourth > 255) {
                return false;
            }
            return first == 127 || first == 10
                    || (first == 172 && second >= 16 && second <= 31)
                    || (first == 192 && second == 168)
                    || (first == 169 && second == 254);
        }
        // A single-label name is a compose service / internal DNS name, never a public
        // FQDN. Anything left with a colon is a public IPv6 literal.
        return !value.contains(".") && !value.contains(":");
    }

    private static DomainException invalid(String detail) {
        return DomainException.unprocessable(ErrorCode.TRANSLATION_URL_INVALID,
                "Translation provider URL is invalid",
                Map.of("field", "url", "reason", detail));
    }
}
