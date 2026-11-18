package ru.krug.backend.auth.infrastructure.keycloak;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.http.client.SimpleClientHttpRequestFactory;

import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Shared internal Keycloak HTTP client. The admin-cli bearer token is cached in memory
 * until shortly before expiry; credentials and tokens are never logged.
 */
@Component
public class KeycloakHttp {

    private record Cached(String token, Instant expiresAt) {
    }

    private final RestClient restClient;
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
    }

    public RestClient restClient() {
        return restClient;
    }

    public ObjectMapper objectMapper() {
        return objectMapper;
    }

    public KeycloakEndpoints endpoints() {
        return endpoints;
    }

    public String adminToken() {
        if (isBlank(properties.keycloak().adminPassword())) {
            throw new ProviderUnavailableException();
        }
        Cached current = cachedAdminToken;
        if (current != null && clock.now().isBefore(current.expiresAt())) {
            return current.token();
        }
        synchronized (this) {
            Cached again = cachedAdminToken;
            if (again != null && clock.now().isBefore(again.expiresAt())) {
                return again.token();
            }
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("grant_type", "password");
            form.add("client_id", properties.keycloak().adminClientId());
            form.add("username", properties.keycloak().adminUsername());
            form.add("password", properties.keycloak().adminPassword());
            Map<String, Object> response;
            try {
                response = restClient.post()
                        .uri(endpoints.adminTokenUrl())
                        .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .body(form)
                        .exchange((request, httpResponse) -> {
                            if (httpResponse.getStatusCode().value() != 200) {
                                throw new ProviderUnavailableException();
                            }
                            return readMap(httpResponse.getBody());
                        });
            } catch (ProviderUnavailableException ex) {
                throw ex;
            } catch (RestClientException ex) {
                throw new ProviderUnavailableException();
            }
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

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
