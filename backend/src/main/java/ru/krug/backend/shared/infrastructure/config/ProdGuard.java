package ru.krug.backend.shared.infrastructure.config;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.context.EnvironmentAware;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * B-02 prod guard. Runs as a BeanFactoryPostProcessor, i.e. before any datasource/Flyway
 * bean is created, and fails with one aggregated, actionable error instead of a random
 * connection failure or, worse, a silent start with development defaults.
 *
 * <p>{@code prod} requires all of: KRUG_AUTH_JWT_SECRET, KRUG_CONTENT_KEY, KRUG_OIDC_ISSUER,
 * KRUG_OIDC_JWKS_URI, DB_URL/DB_USER/DB_PASSWORD and FLYWAY_USER/FLYWAY_PASSWORD.
 * {@code keycloak} does not use the HMAC decoder, so its secret is optional; it still
 * requires a strong content key and OIDC settings. Dev/test password defaults are rejected
 * for remote databases in both profiles.</p>
 */
@Component
@Profile({"prod", "keycloak"})
public class ProdGuard implements BeanFactoryPostProcessor, EnvironmentAware {

    static final Set<String> DEV_JWT_SECRETS = Set.of(
            "dev-only-jwt-secret-change-me-32-bytes-min",
            "test-only-jwt-secret-please-change-32-bytes-min");

    static final Set<String> DEV_CONTENT_KEYS = Set.of(
            "dev-only-content-key-change-me-32-bytes",
            "test-only-content-key-please-change-32-bytes");

    static final Set<String> DEV_DB_PASSWORDS = Set.of("krug_app", "krug_migrator");

    private Environment environment;

    public ProdGuard() {
    }

    public ProdGuard(Environment environment) {
        this.environment = environment;
    }

    @Override
    public void setEnvironment(Environment environment) {
        this.environment = environment;
    }

    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) {
        validate();
    }

    /** Public for the fail-fast unit test; production calls it from the BFPP hook. */
    public void validate() {
        if (environment == null) {
            throw new IllegalStateException("ProdGuard requires an Environment");
        }
        Set<String> profiles = new LinkedHashSet<>(Arrays.asList(environment.getActiveProfiles()));
        boolean prod = profiles.contains("prod");
        boolean keycloak = profiles.contains("keycloak");
        if (!prod && !keycloak) {
            return;
        }

        List<String> violations = new ArrayList<>();
        String contentKey = value("krug.content.key");
        requireSecret("krug.content.key", "KRUG_CONTENT_KEY", contentKey, DEV_CONTENT_KEYS,
                violations);

        require("krug.oidc.issuer", "KRUG_OIDC_ISSUER", violations);
        require("krug.oidc.jwk-set-uri", "KRUG_OIDC_JWKS_URI", violations);
        require("krug.oidc.audience", "KRUG_OIDC_AUDIENCE", violations);
        require("krug.oidc.authorized-party", "KRUG_OIDC_AZP", violations);

        if (prod) {
            String jwtSecret = value("krug.auth.jwt-secret");
            requireSecret("krug.auth.jwt-secret", "KRUG_AUTH_JWT_SECRET", jwtSecret,
                    DEV_JWT_SECRETS, violations);

            // #103: runtime Keycloak administration must use the client-credentials
            // service account, never a password-grant technical user or admin-cli.
            require("krug.auth-bff.keycloak.service-client-id",
                    "KRUG_KEYCLOAK_SERVICE_CLIENT_ID", violations);
            String serviceSecret = require("krug.auth-bff.keycloak.service-client-secret",
                    "KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET", violations);
            if (!serviceSecret.isBlank() && !serviceSecret.contains("${")
                    && serviceSecret.length() < 32) {
                violations.add("KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET must be at least 32 characters");
            }
            String cookieSecure = value("krug.auth-bff.refresh-cookie.secure");
            if ("false".equalsIgnoreCase(cookieSecure)) {
                violations.add("KRUG_AUTH_BFF_COOKIE_SECURE must be true in prod");
            }
            // Browsers send Origin on state-changing auth requests; an empty allowlist
            // would make login/refresh fail closed (or, if bypassed, weaken CSRF).
            require("krug.cors.allowed-origins", "KRUG_CORS_ALLOWED_ORIGINS", violations);
        } else {
            String jwtSecret = value("krug.auth.jwt-secret");
            if (!jwtSecret.isBlank() && DEV_JWT_SECRETS.contains(jwtSecret)) {
                violations.add("KRUG_AUTH_JWT_SECRET uses a development default");
            }
        }

        String dbUrl = require("spring.datasource.url", "DB_URL", violations);
        require("spring.datasource.username", "DB_USER", violations);
        String dbPassword = require("spring.datasource.password", "DB_PASSWORD", violations);
        require("spring.flyway.user", "FLYWAY_USER", violations);
        String flywayPassword = require("spring.flyway.password", "FLYWAY_PASSWORD", violations);

        if (isRemote(dbUrl)) {
            if (DEV_DB_PASSWORDS.contains(dbPassword)) {
                violations.add("DB_PASSWORD uses a development default");
            }
            if (DEV_DB_PASSWORDS.contains(flywayPassword)) {
                violations.add("FLYWAY_PASSWORD uses a development default");
            }
        }

        if (!violations.isEmpty()) {
            throw new IllegalStateException("Insecure " + profiles + " configuration: "
                    + String.join("; ", violations));
        }
    }

    private String require(String property, String envName, List<String> violations) {
        String resolved = value(property);
        if (resolved.isBlank() || resolved.contains("${")) {
            violations.add(envName + " is required (no dev default in this profile)");
        }
        return resolved;
    }

    private static void requireSecret(String property, String envName, String resolved,
                                      Set<String> devValues, List<String> violations) {
        if (resolved.isBlank() || resolved.contains("${")) {
            violations.add(envName + " is required (no dev default in this profile)");
            return;
        }
        if (devValues.contains(resolved)) {
            violations.add(envName + " uses a development/test default");
        }
        if (resolved.length() < 32) {
            violations.add(envName + " must be at least 32 characters");
        }
    }

    private String value(String property) {
        String value = environment.getProperty(property);
        return value == null ? "" : value.strip();
    }

    private static boolean isRemote(String dbUrl) {
        if (dbUrl.isBlank()) {
            return false;
        }
        // Testcontainers and the local dev compose both point at localhost; only a remote
        // host makes the development DB passwords a real production risk.
        if (dbUrl.startsWith("jdbc:tc:")) {
            return false;
        }
        String plain = dbUrl.startsWith("jdbc:") ? dbUrl.substring("jdbc:".length()) : dbUrl;
        try {
            URI uri = URI.create(plain);
            String host = uri.getHost();
            if (host == null) {
                return true;
            }
            String normalized = host.toLowerCase(Locale.ROOT);
            return !(normalized.equals("localhost") || normalized.equals("127.0.0.1")
                    || normalized.equals("::1") || normalized.equals("[::1]"));
        } catch (IllegalArgumentException ex) {
            return true;
        }
    }
}
