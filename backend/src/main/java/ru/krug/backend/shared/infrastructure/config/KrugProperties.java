package ru.krug.backend.shared.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties(prefix = "krug")
public record KrugProperties(
        Auth auth,
        Content content,
        Dev dev,
        RateLimit rateLimit,
        Outbox outbox,
        Oidc oidc,
        E2ee e2ee) {

    public record Auth(
            String jwtSecret,
            String issuer,
            String audience,
            Duration accessTokenTtl) {
    }

    public record Content(String key) {
    }

    public record Dev(
            String defaultDisplayName,
            String workspaceName,
            String chatName) {
    }

    public record RateLimit(
            boolean enabled,
            int sendPerUser,
            Duration sendUserWindow,
            int sendPerChat,
            Duration sendChatWindow,
            @DefaultValue("60") int claimPerUser,
            @DefaultValue("60s") Duration claimUserWindow,
            @DefaultValue("10") int claimPerChat,
            @DefaultValue("60s") Duration claimChatWindow,
            @DefaultValue("10") int inviteAcceptPerUser,
            @DefaultValue("60s") Duration inviteAcceptWindow,
            @DefaultValue("30") int inviteCreatePerChat,
            @DefaultValue("1h") Duration inviteCreateWindow,
            // #96: bot token windows. Independent of user message windows; the transport also
            // caps a single chat so one bot cannot flood a channel.
            @DefaultValue("60") int botSendPerBot,
            @DefaultValue("60s") Duration botSendWindow,
            @DefaultValue("10") int botSendPerChat,
            @DefaultValue("1s") Duration botSendChatWindow) {
    }

    public record Outbox(Relay relay) {

        public record Relay(
                boolean enabled,
                Duration pollInterval,
                @DefaultValue("500") int batchSize) {
        }
    }

    /**
     * Keycloak / OIDC resource-server settings. Active only in the {@code keycloak} and
     * {@code prod} profiles; the dev HMAC decoder does not read these values.
     */
    /**
     * E7 feature flag; false by default until G4. The quarantine retention window is
     * independent from the flag: V19 may have quarantined rows on a database where E2EE is
     * still disabled.
     */
    public record E2ee(
            @DefaultValue("false") boolean enabled,
            @DefaultValue("true") boolean quarantineRetentionEnabled,
            @DefaultValue("90") int quarantineRetentionDays,
            @DefaultValue("24h") Duration quarantineRetentionPollInterval) {
    }

    public record Oidc(
            String issuer,
            String jwkSetUri,
            String audience,
            String authorizedParty,
            @DefaultValue("30s") Duration clockSkew) {
    }
}
