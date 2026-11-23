package ru.krug.backend.auth.infrastructure.keycloak;

import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import ru.krug.backend.auth.application.model.KeycloakSessionView;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.PasswordRejectedException;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.UserAlreadyExistsException;

/**
 * Keycloak Admin REST adapter. Uses the shared authenticated admin client (#103:
 * client-credentials service account, with a one-shot 401 token refresh). Deliberately
 * never logs request bodies, credentials or user emails; transport failures become a
 * generic 503 cause.
 */
@Component
public class KeycloakAdminAdapter implements KeycloakAdminPort {

    private final KeycloakHttp http;

    public KeycloakAdminAdapter(KeycloakHttp http) {
        this.http = http;
    }

    @Override
    public Optional<KeycloakUserView> findByEmail(String email) {
        try {
            return http.adminRestClient().get()
                    .uri(uriBuilder -> URI.create(http.endpoints().adminUsersUrl()
                            + "?email=" + urlEncode(email) + "&exact=true"))
                    .exchange((request, response) -> {
                        if (response.getStatusCode().value() != 200) {
                            throw new ProviderUnavailableException();
                        }
                        List<Map<String, Object>> users = http.objectMapper().readValue(
                                response.getBody(),
                                new TypeReference<List<Map<String, Object>>>() {
                                });
                        return users.stream()
                                .map(this::map)
                                .filter(user -> email.equalsIgnoreCase(user.email()))
                                .findFirst();
                    });
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public Optional<KeycloakUserView> findById(UUID userId) {
        try {
            return http.adminRestClient().get()
                    .uri(http.endpoints().adminUserUrl(userId.toString()))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 404) {
                            return Optional.<KeycloakUserView>empty();
                        }
                        if (status != 200) {
                            throw new ProviderUnavailableException();
                        }
                        return Optional.of(map(http.objectMapper().readValue(
                                response.getBody(),
                                new TypeReference<Map<String, Object>>() {
                                })));
                    });
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public UUID createUser(String email, String displayName) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("username", email);
        body.put("email", email);
        body.put("firstName", displayName);
        // Keycloak 26's default user profile requires a non-empty lastName for a direct
        // grant ("Account is not fully set up"). The firstName is the user-visible display
        // name; lastName is a non-empty counterpart so login works. Identity mapping prefers
        // given_name (see KeycloakClaims / KeycloakTokenExchangeAdapter).
        body.put("lastName", displayName);
        body.put("enabled", false);
        body.put("emailVerified", false);
        body.put("requiredActions", List.of());
        try {
            return http.adminRestClient().post()
                    .uri(http.endpoints().adminUsersUrl())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 409) {
                            throw new UserAlreadyExistsException();
                        }
                        if (status != 201) {
                            throw new ProviderUnavailableException();
                        }
                        UUID fromLocation = parseLocation(
                                response.getHeaders().getFirst(HttpHeaders.LOCATION));
                        if (fromLocation != null) {
                            return fromLocation;
                        }
                        return findByEmail(email).map(KeycloakUserView::id)
                                .orElseThrow(ProviderUnavailableException::new);
                    });
        } catch (UserAlreadyExistsException | ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void setPassword(UUID userId, String password) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "password");
        body.put("value", password);
        body.put("temporary", false);
        try {
            http.adminRestClient().put()
                    .uri(http.endpoints().adminUserUrl(userId.toString()) + "/reset-password")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 204 || status == 200) {
                            return null;
                        }
                        if (status == 400 || status == 422) {
                            throw new PasswordRejectedException();
                        }
                        throw new ProviderUnavailableException();
                    });
        } catch (PasswordRejectedException | ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void updateEnabledAndVerified(UUID userId, boolean enabled, boolean emailVerified) {
        Map<String, Object> body = Map.of("enabled", enabled, "emailVerified", emailVerified);
        try {
            http.adminRestClient().put()
                    .uri(http.endpoints().adminUserUrl(userId.toString()))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status != 204 && status != 200) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void setEnabled(UUID userId, boolean enabled) {
        // Partial update: only `enabled` is sent, so emailVerified/requiredActions are kept.
        Map<String, Object> body = Map.of("enabled", enabled);
        try {
            http.adminRestClient().put()
                    .uri(http.endpoints().adminUserUrl(userId.toString()))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status != 204 && status != 200) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void logoutAllSessions(UUID userId) {
        try {
            http.adminRestClient().post()
                    .uri(http.endpoints().adminUserLogoutUrl(userId.toString()))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        // 404: the Keycloak user is already gone; nothing to revoke.
                        if (status != 204 && status != 200 && status != 404) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void updateDisplayName(UUID userId, String displayName) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("firstName", displayName);
        body.put("lastName", displayName);
        try {
            http.adminRestClient().put()
                    .uri(http.endpoints().adminUserUrl(userId.toString()))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        // 404: the Keycloak user is gone; a best-effort sync cannot help.
                        if (status != 204 && status != 200 && status != 404) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public List<KeycloakSessionView> listSessions(UUID userId) {
        try {
            return http.adminRestClient().get()
                    .uri(http.endpoints().adminUserSessionsUrl(userId.toString()))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 404) {
                            return List.<KeycloakSessionView>of();
                        }
                        if (status != 200) {
                            throw new ProviderUnavailableException();
                        }
                        List<Map<String, Object>> sessions = http.objectMapper().readValue(
                                response.getBody(),
                                new TypeReference<List<Map<String, Object>>>() {
                                });
                        return sessions.stream().map(this::mapSession).toList();
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void revokeSession(UUID userId, String sessionId) {
        try {
            http.adminRestClient().delete()
                    .uri(http.endpoints().adminUserSessionUrl(userId.toString(), sessionId))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        // 404: already revoked concurrently; DELETE stays idempotent.
                        if (status != 204 && status != 200 && status != 404) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void revokeSessionById(String sessionId) {
        try {
            http.adminRestClient().delete()
                    .uri(http.endpoints().adminSessionUrl(sessionId))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        // 404: already revoked concurrently; DELETE stays idempotent.
                        if (status != 204 && status != 200 && status != 404) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public void deleteUser(UUID userId) {
        try {
            http.adminRestClient().delete()
                    .uri(http.endpoints().adminUserUrl(userId.toString()))
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status != 204 && status != 200 && status != 404) {
                            throw new ProviderUnavailableException();
                        }
                        return null;
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    private KeycloakSessionView mapSession(Map<String, Object> session) {
        String id = KeycloakHttp.stringValue(session.get("id"));
        long created = KeycloakHttp.longValue(session.get("startTime"), 0L);
        long lastAccess = KeycloakHttp.longValue(session.get("lastAccess"), created);
        return new KeycloakSessionView(id, sessionName(session),
                Instant.ofEpochMilli(created), Instant.ofEpochMilli(lastAccess));
    }

    /**
     * Keycloak has no first-class device name in a session. The client names registered in
     * the session are the only safe, non-identifying label; the IP address and username are
     * deliberately ignored.
     */
    private String sessionName(Map<String, Object> session) {
        Object clients = session.get("clients");
        if (!(clients instanceof Map<?, ?> clientMap) || clientMap.isEmpty()) {
            return "Keycloak session";
        }
        List<String> labels = new ArrayList<>();
        for (Map.Entry<?, ?> entry : clientMap.entrySet()) {
            String label = KeycloakHttp.stringValue(entry.getValue());
            if (label == null || label.isBlank()) {
                label = KeycloakHttp.stringValue(entry.getKey());
            }
            if (label != null && !label.isBlank() && !labels.contains(label)) {
                labels.add(label.strip());
            }
        }
        if (labels.isEmpty()) {
            return "Keycloak session";
        }
        String joined = String.join(", ", labels);
        return joined.length() > 120 ? joined.substring(0, 120) : joined;
    }

    private KeycloakUserView map(Map<String, Object> user) {
        String id = KeycloakHttp.stringValue(user.get("id"));
        String username = KeycloakHttp.stringValue(user.get("username"));
        String email = KeycloakHttp.stringValue(user.get("email"));
        String firstName = KeycloakHttp.stringValue(user.get("firstName"));
        String displayName = firstName == null || firstName.isBlank() ? username : firstName;
        return new KeycloakUserView(
                id == null ? null : UUID.fromString(id),
                username,
                email == null ? username : email,
                displayName,
                KeycloakHttp.booleanValue(user.get("enabled")),
                KeycloakHttp.booleanValue(user.get("emailVerified")));
    }

    private static UUID parseLocation(String location) {
        if (location == null || location.isBlank()) {
            return null;
        }
        String path = location;
        int slash = path.lastIndexOf('/');
        if (slash >= 0) {
            path = path.substring(slash + 1);
        }
        try {
            return UUID.fromString(path);
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private static String urlEncode(String value) {
        return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8);
    }
}
