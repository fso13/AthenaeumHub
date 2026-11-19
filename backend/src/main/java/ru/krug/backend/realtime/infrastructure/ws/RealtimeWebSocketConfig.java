package ru.krug.backend.realtime.infrastructure.ws;

import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
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
    private static final String TOMCAT_TEXT_BUFFER_SIZE =
            "org.apache.tomcat.websocket.textBufferSize";
    private static final String TOMCAT_BINARY_BUFFER_SIZE =
            "org.apache.tomcat.websocket.binaryBufferSize";

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
     * Tomcat reads its WebSocket buffer limits from servlet context init parameters while it
     * creates {@code WsServerContainer}, i.e. before any {@code ServletContextInitializer}
     * runs. Setting them through the servlet context at startup would therefore be too late
     * and frames above Tomcat's 8 KiB default would close with 1009. A context customizer
     * runs before the context starts, so the 64 KiB protocol cap is in force from the first
     * handshake. MockMvc contexts never build a Tomcat factory, so this bean is simply unused
     * there (no ServerContainer is required at refresh time).
     */
    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory>
            realtimeWebSocketBufferCustomizer() {
        return factory -> factory.addContextCustomizers(context -> {
            context.addParameter(TOMCAT_TEXT_BUFFER_SIZE, String.valueOf(MAX_MESSAGE_BYTES));
            context.addParameter(TOMCAT_BINARY_BUFFER_SIZE, String.valueOf(MAX_MESSAGE_BYTES));
        });
    }
}
