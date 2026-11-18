package ru.krug.backend.realtime.infrastructure.ws;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.util.WebUtils;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.usecase.OpenSessionUseCase;
import ru.krug.backend.realtime.domain.exception.RealtimeForbiddenException;
import ru.krug.backend.realtime.infrastructure.config.RealtimeProperties;
import ru.krug.backend.shared.error.DomainException;

/**
 * Authenticates the upgrade with a one-time ticket before the WS handshake. The access token
 * is never accepted in the query string. Failure is a plain HTTP 401/403, not an upgraded
 * connection.
 */
@Component
public class TicketHandshakeInterceptor implements HandshakeInterceptor {

    private final OpenSessionUseCase openSessionUseCase;
    private final CorsConfiguration cors;

    public TicketHandshakeInterceptor(OpenSessionUseCase openSessionUseCase,
                                      RealtimeProperties properties) {
        this.openSessionUseCase = openSessionUseCase;
        this.cors = new CorsConfiguration();
        this.cors.setAllowedOriginPatterns(properties.allowedOriginPatterns());
        this.cors.setAllowedMethods(List.of("GET"));
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) {
        // Reject a foreign browser origin BEFORE consuming the one-time ticket: a rejected
        // origin must not burn a valid ticket (CSWSH/DoS surface). Spring also installs an
        // OriginHandshakeInterceptor, but it runs after custom interceptors.
        String origin = request.getHeaders().getOrigin();
        if (origin != null && !WebUtils.isSameOrigin(request)
                && cors.checkOrigin(origin) == null) {
            response.setStatusCode(HttpStatus.FORBIDDEN);
            return false;
        }

        String ticket = queryParam(request, "ticket");
        if (ticket == null || ticket.isBlank()) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
        try {
            RealtimeSession session = openSessionUseCase.open(ticket);
            attributes.put(RealtimeSession.ATTRIBUTE, session);
            return true;
        } catch (RealtimeForbiddenException ex) {
            response.setStatusCode(HttpStatus.FORBIDDEN);
            return false;
        } catch (DomainException ex) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        } catch (RuntimeException ex) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
        // no-op
    }

    private static String queryParam(ServerHttpRequest request, String name) {
        String query = request.getURI().getRawQuery();
        if (query == null || query.isEmpty()) {
            return null;
        }
        for (String part : query.split("&")) {
            int index = part.indexOf('=');
            if (index <= 0) {
                continue;
            }
            if (name.equals(part.substring(0, index))) {
                return URLDecoder.decode(part.substring(index + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }
}
