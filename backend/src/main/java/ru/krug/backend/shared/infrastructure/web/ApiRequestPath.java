package ru.krug.backend.shared.infrastructure.web;

import java.nio.charset.StandardCharsets;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.web.util.UriUtils;

/**
 * One canonical path view for security filters (E2EE-REVIEW-06 P0-01/P1-01).
 *
 * <p>Embedded Tomcat keeps the raw, percent-encoded form in {@code getRequestURI()} while
 * MVC routes on the decoded form. A filter that matches the raw URI therefore sees
 * {@code /api/v1/%63hats/...} while the controller sees {@code /api/v1/chats/...}. All
 * security decisions must use the same decoded path as the dispatcher.
 *
 * <p>Decoding is deliberately single-pass and strict: no second decode (which would make
 * {@code %2563} a second smuggling opportunity), no {@code +}-as-space conversion (that is
 * form encoding, not a path), and no matrix/path traversal segments.
 */
public final class ApiRequestPath {

    private static final int MAX_PATH_LENGTH = 4096;

    private ApiRequestPath() {
    }

    /**
     * Returns the decoded application path, without context path.
     *
     * @throws InvalidPathException when the path is malformed or contains a construct that
     *                              no legitimate API route needs ({@code ;}, {@code ..},
     *                              control characters, backslash, repeated slash)
     */
    public static String normalized(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null || uri.isEmpty()) {
            throw new InvalidPathException("missing request URI");
        }
        if (uri.length() > MAX_PATH_LENGTH) {
            throw new InvalidPathException("request URI is too long");
        }
        String context = request.getContextPath();
        if (context != null && !context.isEmpty() && uri.startsWith(context)) {
            uri = uri.substring(context.length());
        }
        if (uri.isEmpty()) {
            uri = "/";
        }
        String decoded;
        try {
            decoded = UriUtils.decode(uri, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            throw new InvalidPathException("malformed percent-encoding");
        }
        if (decoded.indexOf(';') >= 0 || decoded.indexOf('\\') >= 0
                || decoded.indexOf('\0') >= 0) {
            throw new InvalidPathException("path contains a forbidden character");
        }
        // E7-B3F3 P2-12: a literal '%' after exactly one decode is a nested percent-encoding
        // (`%2563` -> `%63`). Tomcat/Spring may decode again when routing, which would let
        // the security filter see a different path than the dispatcher (the P0-01 class of
        // bypass). No legitimate API route needs a literal '%', so reject it here instead
        // of relying on a second decoder to agree with this one.
        if (decoded.indexOf('%') >= 0) {
            throw new InvalidPathException("path contains a nested percent-encoding");
        }
        for (int i = 0; i < decoded.length(); i++) {
            char value = decoded.charAt(i);
            if (Character.isISOControl(value) || Character.isSurrogate(value)) {
                throw new InvalidPathException("path contains a control character");
            }
        }
        String[] segments = decoded.split("/", -1);
        for (String segment : segments) {
            if (".".equals(segment) || "..".equals(segment)) {
                throw new InvalidPathException("path contains a traversal segment");
            }
        }
        if (decoded.contains("//")) {
            throw new InvalidPathException("path contains an empty segment");
        }
        return decoded;
    }

    /** Thrown for a path that must not be routed or matched by a security filter. */
    public static final class InvalidPathException extends RuntimeException {

        public InvalidPathException(String message) {
            super(message, null, false, false);
        }
    }
}
