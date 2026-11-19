package ru.krug.backend.realtime.infrastructure.config;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** `krug.realtime` settings; single-node E3 defaults match contracts/ws-protocol.md. */
@ConfigurationProperties(prefix = "krug.realtime")
public record RealtimeProperties(
        @DefaultValue("ws://localhost:8081/ws") String wsUrl,
        @DefaultValue("http://localhost:5173") String allowedOrigins,
        @DefaultValue("30s") Duration ticketTtl,
        @DefaultValue("200") int maxSubscriptions,
        @DefaultValue("500") int replayLimit,
        @DefaultValue("256") int outboundQueueCapacity,
        @DefaultValue("25s") Duration heartbeatInterval,
        @DefaultValue("60s") Duration heartbeatTimeout,
        @DefaultValue("5s") Duration typingTtl,
        @DefaultValue("60s") Duration presenceTtl,
        @DefaultValue("120") int callSignalLimit,
        @DefaultValue("60s") Duration callSignalWindow,
        @DefaultValue("32768") int callSdpMaxBytes,
        @DefaultValue("4096") int callCandidateMaxBytes) {

    public RealtimeProperties {
        if (allowedOrigins == null) {
            allowedOrigins = "";
        }
        if (Arrays.stream(allowedOrigins.split(","))
                .map(String::strip)
                .anyMatch("*"::equals)) {
            throw new IllegalArgumentException("krug.realtime.allowed-origins must not be '*'");
        }
        if (ticketTtl == null || ticketTtl.isZero() || ticketTtl.isNegative()) {
            throw new IllegalArgumentException("krug.realtime.ticket-ttl must be positive");
        }
        if (maxSubscriptions < 1 || replayLimit < 1 || outboundQueueCapacity < 1) {
            throw new IllegalArgumentException("realtime limits must be positive");
        }
        if (heartbeatInterval == null || heartbeatTimeout == null
                || heartbeatInterval.isZero() || heartbeatTimeout.isZero()) {
            throw new IllegalArgumentException("realtime heartbeat settings must be positive");
        }
        if (typingTtl == null || typingTtl.isZero() || presenceTtl == null
                || presenceTtl.isZero()) {
            throw new IllegalArgumentException("realtime TTL settings must be positive");
        }
        if (callSignalLimit < 1 || callSignalWindow == null || callSignalWindow.isZero()
                || callSignalWindow.isNegative() || callSdpMaxBytes < 1
                || callCandidateMaxBytes < 1) {
            throw new IllegalArgumentException("realtime call signaling limits must be positive");
        }
        if (callSdpMaxBytes >= 64 * 1024) {
            throw new IllegalArgumentException("call SDP limit must stay below the WS frame cap");
        }
    }

    /**
     * Comma-separated allowlist from {@code KRUG_WS_ALLOWED_ORIGINS}. An empty list rejects
     * browser origins (native clients without an Origin header still work), so prod fails
     * closed until the deployment supplies its SPA origin(s).
     */
    public List<String> allowedOriginPatterns() {
        return Arrays.stream(allowedOrigins.split(","))
                .map(String::strip)
                .filter(origin -> !origin.isEmpty())
                .toList();
    }
}
