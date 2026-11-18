package ru.krug.backend.realtime.infrastructure.ws;

import jakarta.websocket.server.ServerContainer;

import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import ru.krug.backend.realtime.infrastructure.config.RealtimeProperties;

/**
 * Registers `/ws`. The HTTP upgrade is permitted by Spring Security and authenticated solely
 * by the one-time ticket in the handshake interceptor.
 */
@Configuration
@EnableWebSocket
public class RealtimeWebSocketConfig implements WebSocketConfigurer {

    private static final int MAX_MESSAGE_BYTES = 64 * 1024;

    private final RealtimeWebSocketHandler handler;
    private final TicketHandshakeInterceptor ticketHandshakeInterceptor;
    private final RealtimeProperties properties;

    public RealtimeWebSocketConfig(RealtimeWebSocketHandler handler,
                                   TicketHandshakeInterceptor ticketHandshakeInterceptor,
                                   RealtimeProperties properties) {
        this.handler = handler;
        this.ticketHandshakeInterceptor = ticketHandshakeInterceptor;
        this.properties = properties;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        String[] allowedOrigins = properties.allowedOriginPatterns().toArray(String[]::new);
        registry.addHandler(handler, "/ws")
                .addInterceptors(ticketHandshakeInterceptor)
                .setAllowedOriginPatterns(allowedOrigins);
    }

    /**
     * Applies buffer limits only when a real servlet container is present. A
     * ServletServerContainerFactoryBean would fail in MockMvc contexts (no ServerContainer).
     */
    @Bean
    public ServletContextInitializer realtimeWebSocketContainerInitializer() {
        return servletContext -> {
            Object attribute = servletContext.getAttribute(
                    "jakarta.websocket.server.ServerContainer");
            if (attribute instanceof ServerContainer container) {
                container.setDefaultMaxTextMessageBufferSize(MAX_MESSAGE_BYTES);
                container.setDefaultMaxBinaryMessageBufferSize(MAX_MESSAGE_BYTES);
                // Heartbeat is owned by InMemoryRealtimeHub, not the servlet container.
                container.setDefaultMaxSessionIdleTimeout(0L);
            }
        };
    }
}
