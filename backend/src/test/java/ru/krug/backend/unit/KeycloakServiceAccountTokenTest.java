package ru.krug.backend.unit;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.auth.infrastructure.keycloak.KeycloakAdminAdapter;
import ru.krug.backend.auth.infrastructure.keycloak.KeycloakEndpoints;
import ru.krug.backend.auth.infrastructure.keycloak.KeycloakHttp;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;
import ru.krug.backend.support.AuthBffTestData;
import ru.krug.backend.support.MutableClock;

/**
 * #103: the Keycloak Admin API client prefers the client-credentials service account,
 * caches its token, re-acquires it once after a 401, and keeps the documented password
 * fallback only when the service account is not configured.
 */
class KeycloakServiceAccountTokenTest {

    private static final String SERVICE_SECRET = "svc-krug-bff-test-secret-please-change-32";
    private static final String REALM_TOKEN =
            "/realms/krug/protocol/openid-connect/token";
    private static final String ADMIN_USERS = "/admin/realms/krug/users";

    private WireMockServer server;
    private KeycloakHttp http;
    private KeycloakAdminAdapter adapter;

    @BeforeEach
    void start() {
        server = new WireMockServer(WireMockConfiguration.options().dynamicPort());
        server.start();
        http = client("svc-krug-bff", SERVICE_SECRET);
        adapter = new KeycloakAdminAdapter(http);
    }

    @AfterEach
    void stop() {
        server.stop();
    }

    @Test
    void clientCredentialsTokenIsAcquiredOnceAndReused() {
        server.stubFor(post(urlEqualTo(REALM_TOKEN))
                .willReturn(okJson("{\"access_token\":\"svc-1\",\"expires_in\":300}")));
        server.stubFor(get(urlPathEqualTo(ADMIN_USERS)).willReturn(okJson("[]")));

        assertThat(adapter.findByEmail("first@krug.test")).isEmpty();
        assertThat(adapter.findByEmail("second@krug.test")).isEmpty();

        assertThat(realmTokenRequests()).isEqualTo(1);
        assertThat(server.findAll(postRequestedFor(urlEqualTo(REALM_TOKEN))).get(0)
                .getBodyAsString())
                .contains("grant_type=client_credentials")
                .contains("client_id=svc-krug-bff")
                .doesNotContain("password=");
    }

    @Test
    void admin401ReacquiresTheTokenAndReplaysTheRequestOnce() {
        server.stubFor(post(urlEqualTo(REALM_TOKEN))
                .inScenario("tokens")
                .whenScenarioStateIs(Scenario.STARTED)
                .willReturn(okJson("{\"access_token\":\"svc-1\",\"expires_in\":300}"))
                .willSetStateTo("second"));
        server.stubFor(post(urlEqualTo(REALM_TOKEN))
                .inScenario("tokens")
                .whenScenarioStateIs("second")
                .willReturn(okJson("{\"access_token\":\"svc-2\",\"expires_in\":300}")));
        server.stubFor(get(urlPathEqualTo(ADMIN_USERS))
                .inScenario("admin")
                .whenScenarioStateIs(Scenario.STARTED)
                .willReturn(aResponse().withStatus(401))
                .willSetStateTo("ok"));
        server.stubFor(get(urlPathEqualTo(ADMIN_USERS))
                .inScenario("admin")
                .whenScenarioStateIs("ok")
                .willReturn(okJson("[]")));

        assertThat(adapter.findByEmail("retry@krug.test")).isEmpty();

        assertThat(realmTokenRequests()).isEqualTo(2);
        assertThat(server.findAll(getRequestedFor(urlPathEqualTo(ADMIN_USERS)))).hasSize(2);
        assertThat(server.findAll(getRequestedFor(urlPathEqualTo(ADMIN_USERS))).get(1)
                .getHeader("Authorization")).isEqualTo("Bearer svc-2");
    }

    @Test
    void passwordFallbackIsUsedOnlyWhenTheServiceAccountIsBlank() {
        http = client("", "");
        adapter = new KeycloakAdminAdapter(http);
        server.stubFor(post(urlEqualTo("/realms/master/protocol/openid-connect/token"))
                .willReturn(okJson("{\"access_token\":\"admin-legacy\",\"expires_in\":300}")));
        server.stubFor(get(urlPathEqualTo(ADMIN_USERS)).willReturn(okJson("[]")));

        assertThat(adapter.findByEmail("fallback@krug.test")).isEmpty();

        assertThat(server.findAll(postRequestedFor(
                urlEqualTo("/realms/master/protocol/openid-connect/token")))).hasSize(1);
        assertThat(realmTokenRequests()).isZero();
    }

    @Test
    void halfConfiguredServiceAccountFailsClosedWithoutFallingBackToAPassword() {
        for (String[] pair : new String[][]{{"svc-krug-bff", ""}, {"", SERVICE_SECRET}}) {
            http = client(pair[0], pair[1]);
            adapter = new KeycloakAdminAdapter(http);
            server.stubFor(get(urlPathEqualTo(ADMIN_USERS)).willReturn(okJson("[]")));

            assertThatThrownBy(() -> adapter.findByEmail("half@krug.test"))
                    .isInstanceOf(ProviderUnavailableException.class);
            assertThat(server.findAll(postRequestedFor(
                    urlEqualTo("/realms/master/protocol/openid-connect/token")))).isEmpty();
        }
    }

    private KeycloakHttp client(String serviceClientId, String serviceClientSecret) {
        KrugProperties krug = new KrugProperties(null, null, null, null, null,
                new KrugProperties.Oidc("", "", "krug-api", "krug-web", null), null);
        AuthBffProperties properties = properties(serviceClientId, serviceClientSecret);
        KeycloakEndpoints endpoints = new KeycloakEndpoints(properties, krug);
        return new KeycloakHttp(new ObjectMapper(), endpoints, properties,
                new MutableClock(Instant.parse("2026-01-01T00:00:00Z")));
    }

    private AuthBffProperties properties(String serviceClientId, String serviceClientSecret) {
        AuthBffProperties base = AuthBffTestData.properties();
        return new AuthBffProperties(
                base.registrationEnabled(), base.trustForwardedFor(), base.pendingSessionTtl(),
                new AuthBffProperties.Keycloak(
                        server.baseUrl(), "krug", "master", "admin", "admin-password",
                        "admin-cli", "krug-web", serviceClientId, serviceClientSecret,
                        Duration.ofSeconds(2), Duration.ofSeconds(2), Duration.ofSeconds(10)),
                base.mail(), base.code(), base.twoFactor(), base.rateLimit(), base.cleanup(),
                base.refreshCookie());
    }

    private int realmTokenRequests() {
        return server.findAll(postRequestedFor(urlEqualTo(REALM_TOKEN))).size();
    }
}
