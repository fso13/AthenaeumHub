package ru.krug.backend.shared.infrastructure.security;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import ru.krug.backend.shared.api.RequestIdFilter;
import ru.krug.backend.shared.application.model.AuthenticatedActor;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.infrastructure.web.ApiRequestPath;

/**
 * Resolves the caller before the controller runs:
 *
 * <ol>
 *   <li>authenticated JWT -> profile strategy (dev claim / Keycloak DB binding);</li>
 *   <li>JIT-provisions the local user in the Keycloak profile;</li>
 *   <li>enforces X-Device-Id only where the OpenAPI contract declares it.</li>
 * </ol>
 *
 * <p>E2EE-REVIEW-06 P0-01: path matching uses the decoded servlet path, not the raw
 * percent-encoded URI. Otherwise {@code GET /api/v1/%63hats/{id}/%6Dessages} reaches the
 * controller without a device binding check and the caller can read another device's
 * envelope. The same predicate is reused by {@code PayloadLimitFilter}.
 *
 * <p>Public paths are exempt. A binding failure is a 401 contract envelope; a forbidden
 * (suspended) user is a 403 envelope.
 */
@Component
public class DeviceBindingFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Device-Id";
    public static final String REASON_ATTRIBUTE = DeviceBindingFilter.class.getName() + ".reason";

    private final DeviceBindingStrategy strategy;
    private final AuthenticationEntryPoint authenticationEntryPoint;
    private final AccessDeniedHandler accessDeniedHandler;

    public DeviceBindingFilter(DeviceBindingStrategy strategy,
                               AuthenticationEntryPoint authenticationEntryPoint,
                               AccessDeniedHandler accessDeniedHandler) {
        this.strategy = strategy;
        this.authenticationEntryPoint = authenticationEntryPoint;
        this.accessDeniedHandler = accessDeniedHandler;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        try {
            String path = ApiRequestPath.normalized(request);
            return path.equals("/api/v1/health")
                    || path.equals("/api/v1/dev/session")
                    || path.equals("/api/v1/setup/status")
                    || path.equals("/ws")
                    || path.startsWith("/api/v1/auth/")
                    || path.startsWith("/error");
        } catch (ApiRequestPath.InvalidPathException ex) {
            // Malformed/encoded-traversal paths are never public: let doFilter reject them.
            return false;
        }
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication instanceof JwtAuthenticationToken jwtAuthentication) {
            String path;
            try {
                path = ApiRequestPath.normalized(request);
            } catch (ApiRequestPath.InvalidPathException ex) {
                SecurityContextHolder.clearContext();
                request.setAttribute(REASON_ATTRIBUTE, "invalid_path");
                authenticationEntryPoint.commence(request, response,
                        new InsufficientAuthenticationException("Unsupported request path"));
                return;
            }
            try {
                AuthenticatedActor actor = strategy.resolve(jwtAuthentication,
                        request.getHeader(HEADER), requiresDevice(path, request.getMethod()),
                        RequestIdFilter.requestId(request));
                request.setAttribute(AuthenticatedActor.REQUEST_ATTRIBUTE, actor);
            } catch (DeviceBindingException ex) {
                SecurityContextHolder.clearContext();
                request.setAttribute(REASON_ATTRIBUTE, "device_mismatch");
                authenticationEntryPoint.commence(request, response,
                        new InsufficientAuthenticationException(ex.getMessage()));
                return;
            } catch (DomainException ex) {
                SecurityContextHolder.clearContext();
                if (ex.category() == ErrorCategory.FORBIDDEN) {
                    accessDeniedHandler.handle(request, response,
                            new AccessDeniedException(ex.getMessage()));
                } else {
                    authenticationEntryPoint.commence(request, response,
                            new InsufficientAuthenticationException(ex.getMessage()));
                }
                return;
            }
        }
        filterChain.doFilter(request, response);
    }

    /**
     * The contract declares X-Device-Id on workspace/chat/sync operations, but not on
     * {@code GET /me} or {@code POST /devices} (a device does not exist yet).
     *
     * <p>E2EE message routes live under {@code /api/v1/chats/} and are therefore always
     * device-bound; the predicate is evaluated on the decoded path.
     */
    private static boolean requiresDevice(String path, String method) {
        // POST /devices is the only device-scoped operation without a device yet.
        boolean deviceMutation = path.startsWith("/api/v1/devices/")
                || (path.equals("/api/v1/devices")
                    && !"POST".equalsIgnoreCase(method));
        return path.equals("/api/v1/sync")
                || path.equals("/api/v1/workspaces")
                || path.startsWith("/api/v1/workspaces/")
                || path.startsWith("/api/v1/chats/")
                || path.startsWith("/api/v1/sticker-packs")
                || path.startsWith("/api/v1/stickers/")
                || path.equals("/api/v1/keys/claim")
                || deviceMutation;
    }
}
