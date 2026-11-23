package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.mock.env.MockEnvironment;

import ru.krug.backend.shared.infrastructure.config.ProdGuard;

class ProdGuardTest {

    private static final String STRONG_CONTENT_KEY = "prod-test-content-key-please-change-32-bytes";
    private static final String STRONG_JWT_SECRET = "prod-test-jwt-secret-please-change-32-bytes";

    @Test
    void prodWithoutEnvironmentFailsFastWithEveryMissingSetting() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("prod");

        assertThatThrownBy(() -> new ProdGuard(environment).validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("KRUG_AUTH_JWT_SECRET")
                .hasMessageContaining("KRUG_CONTENT_KEY")
                .hasMessageContaining("KRUG_OIDC_ISSUER")
                .hasMessageContaining("DB_URL")
                .hasMessageContaining("DB_PASSWORD")
                .hasMessageContaining("FLYWAY_PASSWORD");
    }

    @Test
    void prodWithStrongSettingsStarts() {
        MockEnvironment environment = prodEnvironment();

        assertThatCode(() -> new ProdGuard(environment).validate())
                .doesNotThrowAnyException();
    }

    @Test
    void prodRejectsDevelopmentSecretsAndRemoteDevDatabasePasswords() {
        MockEnvironment environment = prodEnvironment()
                .withProperty("krug.content.key", "dev-only-content-key-change-me-32-bytes")
                .withProperty("krug.auth.jwt-secret", "dev-only-jwt-secret-change-me-32-bytes-min")
                .withProperty("spring.datasource.url", "jdbc:postgresql://db.example:5432/krug")
                .withProperty("spring.datasource.password", "krug_app")
                .withProperty("spring.flyway.password", "krug_migrator");

        assertThatThrownBy(() -> new ProdGuard(environment).validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("KRUG_CONTENT_KEY uses a development/test default")
                .hasMessageContaining("KRUG_AUTH_JWT_SECRET uses a development/test default")
                .hasMessageContaining("DB_PASSWORD uses a development default")
                .hasMessageContaining("FLYWAY_PASSWORD uses a development default");
    }

    @Test
    void prodRequiresTheServiceAccountAndASecureRefreshCookie() {
        MockEnvironment environment = prodEnvironment()
                .withProperty("krug.auth-bff.keycloak.service-client-id", "")
                .withProperty("krug.auth-bff.keycloak.service-client-secret", "")
                .withProperty("krug.auth-bff.refresh-cookie.secure", "false")
                .withProperty("krug.cors.allowed-origins", "");

        assertThatThrownBy(() -> new ProdGuard(environment).validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("KRUG_KEYCLOAK_SERVICE_CLIENT_ID")
                .hasMessageContaining("KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET")
                .hasMessageContaining("KRUG_AUTH_BFF_COOKIE_SECURE must be true in prod")
                .hasMessageContaining("KRUG_CORS_ALLOWED_ORIGINS");
    }

    @Test
    void keycloakProfileDoesNotRequireTheServiceAccountForLocalDev() {
        MockEnvironment keycloak = keycloakEnvironment();
        assertThatCode(() -> new ProdGuard(keycloak).validate()).doesNotThrowAnyException();
    }

    @Test
    void keycloakProfileDoesNotRequireTheHmacSecretButRejectsTheDevContentKey() {
        MockEnvironment keycloak = keycloakEnvironment();
        assertThatCode(() -> new ProdGuard(keycloak).validate()).doesNotThrowAnyException();

        keycloak.withProperty("krug.content.key", "dev-only-content-key-change-me-32-bytes");
        assertThatThrownBy(() -> new ProdGuard(keycloak).validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("KRUG_CONTENT_KEY uses a development/test default");
    }

    @Test
    void prodGuardIsWiredAsAnEarlyBeanFactoryPostProcessor() {
        AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
        context.getEnvironment().setActiveProfiles("prod");
        context.register(ProdGuard.class);

        assertThatThrownBy(context::refresh)
                .hasMessageContaining("Insecure [prod] configuration")
                .hasMessageContaining("KRUG_CONTENT_KEY");
    }

    private static MockEnvironment prodEnvironment() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("prod");
        return environment
                .withProperty("krug.content.key", STRONG_CONTENT_KEY)
                .withProperty("krug.auth.jwt-secret", STRONG_JWT_SECRET)
                .withProperty("krug.oidc.issuer", "https://id.example/realms/krug")
                .withProperty("krug.oidc.jwk-set-uri",
                        "https://id.example/realms/krug/protocol/openid-connect/certs")
                .withProperty("krug.oidc.audience", "krug-api")
                .withProperty("krug.oidc.authorized-party", "krug-web")
                // #103: prod requires the client-credentials service account and a Secure
                // refresh cookie.
                .withProperty("krug.auth-bff.keycloak.service-client-id", "svc-krug-bff")
                .withProperty("krug.auth-bff.keycloak.service-client-secret",
                        "prod-test-service-client-secret-at-least-32-bytes")
                .withProperty("krug.auth-bff.refresh-cookie.secure", "true")
                .withProperty("krug.cors.allowed-origins", "https://chat.example.com")
                .withProperty("spring.datasource.url",
                        "jdbc:postgresql://localhost:5432/krug")
                .withProperty("spring.datasource.username", "krug_app")
                .withProperty("spring.datasource.password", "local-strong-password")
                .withProperty("spring.flyway.user", "krug_migrator")
                .withProperty("spring.flyway.password", "local-strong-migrator-password");
    }

    private static MockEnvironment keycloakEnvironment() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("keycloak");
        return environment
                .withProperty("krug.content.key", STRONG_CONTENT_KEY)
                .withProperty("krug.auth.jwt-secret", "")
                .withProperty("krug.oidc.issuer", "http://localhost:8180/realms/krug")
                .withProperty("krug.oidc.jwk-set-uri",
                        "http://localhost:8180/realms/krug/protocol/openid-connect/certs")
                .withProperty("krug.oidc.audience", "krug-api")
                .withProperty("krug.oidc.authorized-party", "krug-web")
                .withProperty("spring.datasource.url", "jdbc:postgresql://localhost:5432/krug")
                .withProperty("spring.datasource.username", "krug_app")
                .withProperty("spring.datasource.password", "krug_app")
                .withProperty("spring.flyway.user", "krug_migrator")
                .withProperty("spring.flyway.password", "krug_migrator");
    }
}
