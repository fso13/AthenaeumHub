package ru.krug.backend.auth.infrastructure.keycloak;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpRequest;
import org.springframework.http.MediaType;
import org.springframework.http.client.BufferingClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Shared internal Keycloak HTTP client.
 *
 * <p>The Admin API token is cached in memory until shortly before expiry. Two acquisition
 * modes exist:</p>
 * <ul>
 *   <li>#103 preferred: {@code grant_type=client_credentials} with the confidential
 *       {@code svc-krug-bff} service account in the {@code krug} realm. No user password is
 *       involved and the account carries only {@code manage-users/view-users/query-users}.</li>
 *   <li>dev fallback: the documented technical-user password grant. It is used only when
 *       both service-account settings are blank; a half-configured pair fails closed.</li>
 * </ul>
 *
 * <p>The admin {@link RestClient} retries once on {@code 401}: a token revoked or expired
 * server-side is discarded and one fresh token is acquired before replaying the request.
 * Request bodies and responses are buffered for that replay. Credentials, tokens and admin
 * payloads are never logged.</p>
 */
@Component
public class KeycloakHttp {

    private record Cached(String token, Instant expiresAt) {
    }

    private final RestClient restClient;
    private final RestClient adminRestClient;
    private final ObjectMapper objectMapper;
    private final KeycloakEndpoints endpoints;
    private final AuthBffProperties properties;
    private final ClockPort clock;
    private volatile Cached cachedAdminToken;

    public KeycloakHttp(ObjectMapper objectMapper, KeycloakEndpoints endpoints,
                        AuthBffProperties properties, ClockPort clock) {
        this.objectMapper = objectMapper;
        this.endpoints = endpoints;
        this.properties = properties;
        this.clock = clock;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) Math.max(1,
                properties.keycloak().connectTimeout().toMillis()));
        factory.setReadTimeout((int) Math.max(1, properties.keycloak().readTimeout().toMillis()));
        this.restClient = RestClient.builder().requestFactory(factory).build();
        // Buffering makes the request body replayable, which the 401 re-acquisition needs.
        this.adminRestClient = RestClient.builder()
                .requestFactory(new BufferingClientHttpRequestFactory(factory))
                .requestInterceptor(adminAuthInterceptor())
                .build();
    }

    public RestClient restClient() {
        return restClient;
    }

    /** Authenticated Admin API client; adds the cached bearer and retries one 401. */
    public RestClient adminRestClient() {
        return adminRestClient;
    }

    public ObjectMapper objectMapper() {
        return objectMapper;
    }

    public KeycloakEndpoints endpoints() {
        return endpoints;
    }

    /**
     * Returns a cached Admin API token, acquiring one when the cache is empty or expired.
     * Never logs the token or the client secret.
     */
    public String adminToken() {
        Cached current = cachedAdminToken;
        if (current != null && clock.now().isBefore(current.expiresAt())) {
            return current.token();
        }
        synchronized (this) {
            Cached again = cachedAdminToken;
            if (again != null && clock.now().isBefore(again.expiresAt())) {
                return again.token();
            }
            String token = acquireAdminToken();
            return token;
        }
    }

    /**
     * Drops the cached token only when it is still the one that was rejected, so a
     * concurrent thread that already refreshed the cache is not punished.
     */
    public void invalidateAdminToken(String rejectedToken) {
        if (rejectedToken == null) {
            return;
        }
        synchronized (this) {
            Cached current = cachedAdminToken;
            if (current != null && current.token().equals(rejectedToken)) {
                cachedAdminToken = null;
            }
        }
    }

    public Map<String, Object> readMap(java.io.InputStream body) throws IOException {
        return objectMapper.readValue(body, new TypeReference<Map<String, Object>>() {
        });
    }

    public static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    public static long longValue(Object value, long fallback) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text) {
            try {
                return Long.parseLong(text);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    public static boolean booleanValue(Object value) {
        return Boolean.TRUE.equals(value) || "true".equalsIgnoreCase(stringValue(value));
    }

    private ClientHttpRequestInterceptor adminAuthInterceptor() {
        return (HttpRequest request, byte[] body, ClientHttpRequestExecution execution)
                -> {
            String token = adminToken();
            request.getHeaders().setBearerAuth(token);
            ClientHttpResponse response = execution.execute(request, body);
            if (response.getStatusCode().value() != 401) {
                return response;
            }
            response.close();
            invalidateAdminToken(token);
            String refreshed = adminToken();
            request.getHeaders().setBearerAuth(refreshed);
            return execution.execute(request, body);
        };
    }

    private String acquireAdminToken() {
        String serviceClientId = properties.keycloak().serviceClientId();
        String serviceClientSecret = properties.keycloak().serviceClientSecret();
        boolean hasId = !isBlank(serviceClientId);
        boolean hasSecret = !isBlank(serviceClientSecret);
        if (hasId != hasSecret) {
            // A half-configured service account must not silently fall back to a password.
            throw new ProviderUnavailableException();
        }
        Map<String, Object> response = hasId
                ? serviceAccountGrant(serviceClientId, serviceClientSecret)
                : passwordGrant();
        String token = stringValue(response.get("access_token"));
        if (token == null || token.isBlank()) {
            throw new ProviderUnavailableException();
        }
        long expiresIn = longValue(response.get("expires_in"), 60);
        Duration skew = properties.keycloak().adminTokenSkew() == null
                ? Duration.ofSeconds(30) : properties.keycloak().adminTokenSkew();
        long ttl = Math.max(30, expiresIn - Math.max(0, skew.toSeconds()));
        cachedAdminToken = new Cached(token, clock.now().plusSeconds(ttl));
        return token;
    }

    private Map<String, Object> serviceAccountGrant(String clientId, String clientSecret) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "client_credentials");
        form.add("client_id", clientId);
        form.add("client_secret", clientSecret);
        return postToken(endpoints.tokenUrl(), form);
    }

    private Map<String, Object> passwordGrant() {
        if (isBlank(properties.keycloak().adminPassword())) {
            throw new ProviderUnavailableException();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", properties.keycloak().adminClientId());
        form.add("username", properties.keycloak().adminUsername());
        form.add("password", properties.keycloak().adminPassword());
        return postToken(endpoints.adminTokenUrl(), form);
    }

    private Map<String, Object> postToken(String url, MultiValueMap<String, String> form) {
        try {
            return restClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .exchange((request, httpResponse) -> {
                        int status = httpResponse.getStatusCode().value();
                        if (status != 200) {
                            // 400/401/403: wrong secret/client or disabled service account.
                            throw new ProviderUnavailableException();
                        }
                        return readMap(httpResponse.getBody());
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
