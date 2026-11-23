package ru.krug.backend.auth.infrastructure.security;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.filter.OncePerRequestFilter;

import ru.krug.backend.shared.api.RequestIdFilter;
import ru.krug.backend.shared.api.dto.ApiError;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * #103: CSRF defence for state-changing Auth BFF requests in depth with the
 * {@code SameSite=Lax} refresh cookie.
 *
 * <p>Every mutating {@code /api/v1/auth/**} request that carries an {@code Origin} (or,
 * failing that, a {@code Referer}) must name one of the configured SPA origins. Browsers
 * send {@code Origin} on all POST requests, so a cross-site form/fetch is rejected before
 * the controller can rotate or revoke the cookie. A request without either header is a
 * non-browser client (curl, service call); it cannot be created by a victim browser and is
 * left to the normal authentication checks.</p>
 *
 * <p>Rejections are deliberate generic {@code 403 CSRF_REJECTED} responses: the attacker
 * learns nothing about the cookie or the account.</p>
 */
@Component
public class AuthCsrfFilter extends OncePerRequestFilter {

    private static final String AUTH_PREFIX = "/api/v1/auth/";

    private final CorsConfiguration cors;
    private final ObjectMapper objectMapper;

    public AuthCsrfFilter(CorsConfiguration krugCorsConfiguration, ObjectMapper objectMapper) {
        this.cors = krugCorsConfiguration;
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        if (path == null || !path.startsWith(AUTH_PREFIX)) {
            return true;
        }
        String method = request.getMethod();
        return "GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain)
            throws ServletException, IOException {
        String origin = requestOrigin(request);
        String fetchSite = request.getHeader("Sec-Fetch-Site");
        if ("cross-site".equalsIgnoreCase(fetchSite) || !originAllowed(origin)) {
            reject(response, request);
            return;
        }
        filterChain.doFilter(request, response);
    }

    private boolean originAllowed(String origin) {
        if (origin == null) {
            // No browser Origin/Referer: not a CSRF vector (browsers always send Origin on
            // state-changing requests). SameSite=Lax still protects the cookie.
            return true;
        }
        return cors.checkOrigin(origin) != null;
    }

    private String requestOrigin(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isBlank()) {
            return origin.strip();
        }
        String referer = request.getHeader("Referer");
        if (referer == null || referer.isBlank()) {
            return null;
        }
        try {
            URI uri = URI.create(referer.strip());
            if (uri.getScheme() == null || uri.getRawAuthority() == null) {
                return "";
            }
            return uri.getScheme() + "://" + uri.getRawAuthority();
        } catch (IllegalArgumentException ex) {
            return "";
        }
    }

    private void reject(HttpServletResponse response, HttpServletRequest request)
            throws IOException {
        response.reset();
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        String requestId = RequestIdFilter.requestId(request);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Request-Id", requestId);
        objectMapper.writeValue(response.getWriter(), new ApiError(
                ErrorCode.CSRF_REJECTED,
                "Cross-site request rejected",
                Map.of(),
                requestId));
    }
}
