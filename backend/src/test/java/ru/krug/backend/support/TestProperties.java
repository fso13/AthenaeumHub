package ru.krug.backend.support;

import java.time.Duration;

import ru.krug.backend.shared.infrastructure.config.KrugProperties;

public final class TestProperties {

    public static final String JWT_SECRET = "test-only-jwt-secret-please-change-32-bytes-min";
    public static final String CONTENT_KEY = "test-only-content-key-please-change-32-bytes";

    private TestProperties() {
    }

    public static KrugProperties defaults() {
        return new KrugProperties(
                new KrugProperties.Auth(JWT_SECRET, "krug-dev", "krug-api", Duration.ofMinutes(15)),
                new KrugProperties.Content(CONTENT_KEY),
                new KrugProperties.Dev("Дмитрий", "Дев-воркспейс", "Общий чат"),
                new KrugProperties.RateLimit(true, 30, Duration.ofSeconds(10), 5,
                        Duration.ofSeconds(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(60), 10, Duration.ofSeconds(60), 30,
                        Duration.ofHours(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(1), 10000, Duration.ofSeconds(60), 10000,
                        Duration.ofSeconds(60)),
                new KrugProperties.Outbox(new KrugProperties.Outbox.Relay(false,
                        Duration.ofSeconds(1), 500)),
                new KrugProperties.Oidc("", "", "krug-api", "krug-web", Duration.ofSeconds(30)),
                new KrugProperties.E2ee(false, true, 90, Duration.ofHours(24)));
    }

    public static KrugProperties withRateLimit(int perUser, Duration userWindow, int perChat,
                                               boolean enabled) {
        KrugProperties base = defaults();
        return new KrugProperties(base.auth(), base.content(), base.dev(),
                new KrugProperties.RateLimit(enabled, perUser, userWindow, perChat,
                        Duration.ofSeconds(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(60), 10, Duration.ofSeconds(60), 30,
                        Duration.ofHours(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(1), 10000, Duration.ofSeconds(60), 10000,
                        Duration.ofSeconds(60)),
                base.outbox(), base.oidc(), base.e2ee());
    }

    /** #98: command/response windows for the bot event and response limiter. */
    public static KrugProperties withBotCommandRateLimit(int perUser, Duration commandWindow,
                                                         int perToken,
                                                         Duration responseWindow) {
        KrugProperties base = defaults();
        return new KrugProperties(base.auth(), base.content(), base.dev(),
                new KrugProperties.RateLimit(true, 10000, Duration.ofSeconds(10), 10000,
                        Duration.ofSeconds(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(60), 10, Duration.ofSeconds(60), 30,
                        Duration.ofHours(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(1), perUser, commandWindow, perToken,
                        responseWindow),
                base.outbox(), base.oidc(), base.e2ee());
    }

    /** #96: per-bot/per-chat windows for the bot send limiter. */
    public static KrugProperties withBotRateLimit(int perBot, Duration botWindow, int perChat) {
        KrugProperties base = defaults();
        return new KrugProperties(base.auth(), base.content(), base.dev(),
                new KrugProperties.RateLimit(true, 10000, Duration.ofSeconds(10), 10000,
                        Duration.ofSeconds(1), 60, Duration.ofSeconds(60), 10,
                        Duration.ofSeconds(60), 10, Duration.ofSeconds(60), 30,
                        Duration.ofHours(1), perBot, botWindow, perChat,
                        Duration.ofSeconds(1), 10000, Duration.ofSeconds(60), 10000,
                        Duration.ofSeconds(60)),
                base.outbox(), base.oidc(), base.e2ee());
    }
}
