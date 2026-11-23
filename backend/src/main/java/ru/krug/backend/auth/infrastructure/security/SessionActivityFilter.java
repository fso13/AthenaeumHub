package ru.krug.backend.auth.infrastructure.security;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import ru.krug.backend.auth.application.usecase.SessionActivityService;
import ru.krug.backend.shared.application.model.AuthenticatedActor;
import ru.krug.backend.shared.infrastructure.web.ApiRequestPath;

/**
 * Records one last-activity marker per authenticated API request (#101).
 *
 * <p>Only real API traffic counts: {@code /api/v1/auth/**} (login/refresh/logout) is
 * skipped, so a silently refreshing client does not keep an abandoned session alive. The
 * filter never rejects a request and never reads a request body; an unavailable marker
 * store is fail-open for availability, while the refresh guard still applies the policy to
 * the markers that do exist. The {@code sid} claim and the local user id are the only
 * values written; no token, IP, user agent or content is logged or stored.</p>
 */
@Component
public class SessionActivityFilter extends OncePerRequestFilter {

    private final SessionActivityService activity;

    public SessionActivityFilter(SessionActivityService activity) {
        this.activity = activity;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Use the decoded path, not the raw URI: an encoded `/api/v1/%61uth/refresh` must
        // not be able to reset the idle clock (the device-binding filter uses the same
        // normaliser for the same reason).
        String path;
        try {
            path = ApiRequestPath.normalized(request);
        } catch (ApiRequestPath.InvalidPathException ex) {
            path = request.getRequestURI();
        }
        return path == null || !path.startsWith("/api/v1/")
                || path.startsWith("/api/v1/auth/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication instanceof JwtAuthenticationToken jwtAuthentication) {
            Object attribute = request.getAttribute(AuthenticatedActor.REQUEST_ATTRIBUTE);
            if (attribute instanceof AuthenticatedActor actor) {
                String sessionId = jwtAuthentication.getToken().getClaimAsString("sid");
                try {
                    activity.touch(actor.userId(), sessionId);
                } catch (RuntimeException ignored) {
                    // Activity tracking must not turn a valid request into a 5xx. The
                    // refresh guard remains fail-closed for sessions that do have markers.
                }
            }
        }
        filterChain.doFilter(request, response);
    }
}
