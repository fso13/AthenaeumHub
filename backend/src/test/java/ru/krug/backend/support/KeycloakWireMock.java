package ru.krug.backend.support;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.any;
import static com.github.tomakehurst.wiremock.client.WireMock.anyUrl;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.common.FileSource;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.extension.Parameters;
import com.github.tomakehurst.wiremock.extension.ResponseTransformer;
import com.github.tomakehurst.wiremock.http.HttpHeader;
import com.github.tomakehurst.wiremock.http.HttpHeaders;
import com.github.tomakehurst.wiremock.http.Request;
import com.github.tomakehurst.wiremock.http.Response;

/**
 * In-process WireMock Keycloak: admin users, direct grants, userinfo, logout and JWKS.
 * Access tokens are real RS256 JWTs signed by a test key, so the production Keycloak JWT
 * decoder and {@code GET /me} run end-to-end in AuthBffIT.
 */
public final class KeycloakWireMock {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final KeyPair KEY_PAIR = generateKeyPair();
    private static final String KID = "krug-auth-bff-test";
    private static final String ADMIN_TOKEN = "admin-test-token";

    private static final KeycloakTransformer TRANSFORMER = new KeycloakTransformer();
    private static final WireMockServer SERVER;

    static {
        SERVER = new WireMockServer(WireMockConfiguration.options()
                .dynamicPort()
                .extensions(TRANSFORMER));
        SERVER.start();
        SERVER.stubFor(any(anyUrl()).willReturn(aResponse()
                .withTransformers(TRANSFORMER.getName())));
    }

    private KeycloakWireMock() {
    }

    public static void reset() {
        TRANSFORMER.reset();
        SERVER.resetRequests();
    }

    public static String baseUrl() {
        return SERVER.baseUrl();
    }

    public static String issuer() {
        return baseUrl() + "/realms/krug";
    }

    public static String jwksUri() {
        return issuer() + "/protocol/openid-connect/certs";
    }

    /** Pre-create a verified or pending user directly in the fake IdP. */
    public static TestUser putUser(String email, String name, String password, boolean enabled,
                                   boolean emailVerified) {
        return TRANSFORMER.putUser(email, name, password, enabled, emailVerified);
    }

    public static TestUser user(String email) {
        return TRANSFORMER.user(email);
    }

    /** Pre-create one active Keycloak session for a user (used by the profile session IT). */
    public static TestSession putSession(UUID userId, String sessionId, String clientName,
                                         Instant createdAt, Instant lastAccessAt,
                                         String ipAddress) {
        return TRANSFORMER.putSession(userId, sessionId, clientName, createdAt, lastAccessAt,
                ipAddress);
    }

    public static java.util.List<TestSession> sessions(UUID userId) {
        return TRANSFORMER.sessions(userId);
    }

    /** Make the fake Admin sessions API return 503 (Keycloak outage test). */
    public static void failAdminSessions(boolean fail) {
        TRANSFORMER.failAdminSessions = fail;
    }

    /** Make the fake Admin user update return 503 (best-effort display-name sync test). */
    public static void failUserUpdates(boolean fail) {
        TRANSFORMER.failUserUpdates = fail;
    }

    public static java.util.List<String> events() {
        return SERVER.getAllServeEvents().stream()
                .map(event -> event.getRequest().getMethod() + " "
                        + event.getRequest().getUrl() + " -> "
                        + event.getResponse().getStatus())
                .toList();
    }

    public static final class TestSession {
        private final String id;
        private final String name;
        private final Instant createdAt;
        private final Instant lastAccessAt;
        private final String ipAddress;

        private TestSession(String id, String name, Instant createdAt, Instant lastAccessAt,
                            String ipAddress) {
            this.id = id;
            this.name = name;
            this.createdAt = createdAt;
            this.lastAccessAt = lastAccessAt;
            this.ipAddress = ipAddress;
        }

        public String id() {
            return id;
        }

        public String name() {
            return name;
        }

        public Instant createdAt() {
            return createdAt;
        }

        public Instant lastAccessAt() {
            return lastAccessAt;
        }

        public String ipAddress() {
            return ipAddress;
        }
    }

    public static final class TestUser {
        private final UUID id;
        private final String email;
        private volatile String name;
        private volatile String password;
        private volatile boolean enabled;
        private volatile boolean emailVerified;

        private TestUser(UUID id, String email, String name, String password, boolean enabled,
                         boolean emailVerified) {
            this.id = id;
            this.email = email;
            this.name = name;
            this.password = password;
            this.enabled = enabled;
            this.emailVerified = emailVerified;
        }

        public UUID id() {
            return id;
        }

        public String email() {
            return email;
        }

        public String name() {
            return name;
        }

        public boolean enabled() {
            return enabled;
        }

        public boolean emailVerified() {
            return emailVerified;
        }
    }

    private static final class KeycloakTransformer extends ResponseTransformer {

        private final Map<String, TestUser> byEmail = new ConcurrentHashMap<>();
        private final Map<UUID, TestUser> byId = new ConcurrentHashMap<>();
        private final Map<String, UUID> accessTokens = new ConcurrentHashMap<>();
        private final Map<String, UUID> refreshTokens = new ConcurrentHashMap<>();
        private final Map<UUID, java.util.List<TestSession>> sessionsByUser =
                new ConcurrentHashMap<>();
        private volatile boolean failAdminSessions;
        private volatile boolean failUserUpdates;

        @Override
        public String getName() {
            return "krug-keycloak";
        }

        void reset() {
            byEmail.clear();
            byId.clear();
            accessTokens.clear();
            refreshTokens.clear();
            sessionsByUser.clear();
            failAdminSessions = false;
            failUserUpdates = false;
        }

        TestSession putSession(UUID userId, String sessionId, String clientName,
                               Instant createdAt, Instant lastAccessAt, String ipAddress) {
            TestSession session = new TestSession(sessionId, clientName, createdAt, lastAccessAt,
                    ipAddress);
            sessionsByUser.computeIfAbsent(userId,
                    ignored -> new java.util.concurrent.CopyOnWriteArrayList<>()).add(session);
            return session;
        }

        java.util.List<TestSession> sessions(UUID userId) {
            return java.util.List.copyOf(sessionsByUser.getOrDefault(userId, java.util.List.of()));
        }

        TestUser putUser(String email, String name, String password, boolean enabled,
                         boolean emailVerified) {
            TestUser user = new TestUser(UUID.randomUUID(), email.toLowerCase(Locale.ROOT), name,
                    password, enabled, emailVerified);
            byEmail.put(user.email, user);
            byId.put(user.id, user);
            return user;
        }

        TestUser user(String email) {
            return byEmail.get(email.toLowerCase(Locale.ROOT));
        }

        @Override
        public Response transform(Request request, Response response, FileSource files,
                                  Parameters parameters) {
            try {
                String path = path(request.getUrl());
                String method = request.getMethod().value();
                if (path.equals("/realms/master/protocol/openid-connect/token")
                        && method.equals("POST")) {
                    return adminToken();
                }
                if (path.equals("/realms/krug/protocol/openid-connect/certs")
                        && method.equals("GET")) {
                    return json(200, jwks());
                }
                if (path.equals("/realms/krug/protocol/openid-connect/token")
                        && method.equals("POST")) {
                    return token(request.getBodyAsString());
                }
                if (path.equals("/realms/krug/protocol/openid-connect/userinfo")
                        && method.equals("GET")) {
                    return userInfo(request.getHeader("Authorization"));
                }
                if (path.equals("/realms/krug/protocol/openid-connect/logout")
                        && method.equals("POST")) {
                    return logout(request.getBodyAsString());
                }
                if (path.equals("/admin/realms/krug/users") && method.equals("POST")) {
                    return createUser(request.getBodyAsString());
                }
                if (path.equals("/admin/realms/krug/users") && method.equals("GET")) {
                    return listUsers(request.getUrl());
                }
                if (path.startsWith("/admin/realms/krug/users/")) {
                    if (path.contains("/sessions")) {
                        return sessions(path, method);
                    }
                    if (path.endsWith("/logout") && method.equals("POST")) {
                        return adminLogout(path);
                    }
                    return userById(path, method, request.getBodyAsString());
                }
                return json(404, "{\"error\":\"not_found\"}");
            } catch (RuntimeException ex) {
                return json(500, "{\"error\":\"test_fake_failed\"}");
            }
        }

        private Response adminToken() {
            return json(200, "{\"access_token\":\"" + ADMIN_TOKEN
                    + "\",\"expires_in\":300,\"token_type\":\"Bearer\"}");
        }

        private Response token(String body) {
            Map<String, String> form = parseForm(body);
            String grant = form.getOrDefault("grant_type", "");
            TestUser user;
            if (grant.equals("password")) {
                String username = form.getOrDefault("username", "").toLowerCase(Locale.ROOT);
                user = byEmail.get(username);
                if (user == null || !user.enabled || user.password == null
                        || !MessageDigest.isEqual(
                                user.password.getBytes(StandardCharsets.UTF_8),
                                form.getOrDefault("password", "")
                                        .getBytes(StandardCharsets.UTF_8))) {
                    return invalidGrant();
                }
            } else if (grant.equals("refresh_token")) {
                UUID userId = refreshTokens.remove(form.getOrDefault("refresh_token", ""));
                user = userId == null ? null : byId.get(userId);
                if (user == null || !user.enabled) {
                    return invalidGrant();
                }
            } else {
                return json(400, "{\"error\":\"unsupported_grant_type\"}");
            }
            String accessToken = accessToken(user);
            String refreshToken = "rt-" + UUID.randomUUID();
            accessTokens.put(accessToken, user.id);
            refreshTokens.put(refreshToken, user.id);
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("access_token", accessToken);
            payload.put("refresh_token", refreshToken);
            payload.put("expires_in", 900);
            payload.put("refresh_expires_in", 1800);
            payload.put("token_type", "Bearer");
            payload.put("not-before-policy", 0);
            payload.put("session_state", UUID.randomUUID().toString());
            return json(200, toJson(payload));
        }

        private Response invalidGrant() {
            return json(400, "{\"error\":\"invalid_grant\","
                    + "\"error_description\":\"Invalid user credentials\"}");
        }

        private Response userInfo(String authorization) {
            String token = bearer(authorization);
            UUID userId = token == null ? null : accessTokens.get(token);
            TestUser user = userId == null ? null : byId.get(userId);
            if (user == null) {
                return json(401, "{\"error\":\"invalid_token\"}");
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("sub", user.id.toString());
            payload.put("email", user.email);
            payload.put("email_verified", user.emailVerified);
            payload.put("preferred_username", user.email);
            payload.put("given_name", user.name);
            payload.put("family_name", user.name);
            payload.put("name", user.name + " " + user.name);
            return json(200, toJson(payload));
        }

        private Response logout(String body) {
            Map<String, String> form = parseForm(body);
            refreshTokens.remove(form.getOrDefault("refresh_token", ""));
            return Response.response().status(204).build();
        }

        private Response createUser(String body) throws RuntimeException {
            Map<String, Object> payload = readMap(body);
            String email = string(payload.get("username"));
            String username = email == null ? "" : email.toLowerCase(Locale.ROOT);
            if (byEmail.containsKey(username)) {
                return json(409, "{\"error\":\"User exists with same username\"}");
            }
            String lastName = string(payload.get("lastName"));
            if (lastName == null || lastName.isBlank()) {
                // Keycloak 26 default user profile: direct grant fails without lastName.
                return json(400, "{\"error\":\"User profile validation failed\"}");
            }
            TestUser user = putUser(email, string(payload.get("firstName")), null,
                    Boolean.TRUE.equals(payload.get("enabled")),
                    Boolean.TRUE.equals(payload.get("emailVerified")));
            return Response.response()
                    .status(201)
                    .headers(new HttpHeaders(new HttpHeader("Location",
                            baseUrl() + "/admin/realms/krug/users/" + user.id)))
                    .build();
        }

        private Response listUsers(String url) {
            String email = query(url, "email");
            List<Map<String, Object>> users = new ArrayList<>();
            for (TestUser user : byEmail.values()) {
                if (email == null || user.email.equalsIgnoreCase(email)) {
                    users.add(userJson(user));
                }
            }
            return json(200, toJson(users));
        }

        /**
         * Keycloak Admin API "logout all sessions": invalidates every refresh token of the
         * user. Access tokens are deliberately left in the map: Keycloak itself does not
         * revoke stateless access tokens on this call, and the integration test asserts the
         * refresh/login consequences.
         */
        private Response sessions(String path, String method) {
            if (failAdminSessions) {
                return json(503, "{\"error\":\"service_unavailable\"}");
            }
            String[] parts = path.split("/");
            if (parts.length < 7 || parts.length > 8) {
                return json(404, "{\"error\":\"not_found\"}");
            }
            UUID userId;
            try {
                userId = UUID.fromString(parts[5]);
            } catch (IllegalArgumentException ex) {
                return json(404, "{\"error\":\"not_found\"}");
            }
            if (parts.length == 8) {
                if (!method.equals("DELETE")) {
                    return json(405, "{\"error\":\"method_not_allowed\"}");
                }
                String sessionId = parts[6 + 1];
                sessionsByUser.computeIfPresent(userId, (ignored, list) -> {
                    list.removeIf(session -> session.id().equals(sessionId));
                    return list;
                });
                return Response.response().status(204).build();
            }
            if (!method.equals("GET")) {
                return json(405, "{\"error\":\"method_not_allowed\"}");
            }
            List<Map<String, Object>> payload = new ArrayList<>();
            TestUser user = byId.get(userId);
            for (TestSession session : sessionsByUser.getOrDefault(userId, List.of())) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", session.id());
                row.put("username", user == null ? "" : user.email);
                row.put("ipAddress", session.ipAddress());
                row.put("startTime", session.createdAt().toEpochMilli());
                row.put("lastAccess", session.lastAccessAt().toEpochMilli());
                row.put("clients", Map.of("krug-web", session.name()));
                payload.add(row);
            }
            return json(200, toJson(payload));
        }

        private Response adminLogout(String path) {
            String[] parts = path.split("/");
            UUID id;
            try {
                id = UUID.fromString(parts[parts.length - 2]);
            } catch (IllegalArgumentException ex) {
                return json(404, "{\"error\":\"not_found\"}");
            }
            if (byId.containsKey(id)) {
                refreshTokens.entrySet().removeIf(entry -> entry.getValue().equals(id));
            }
            return Response.response().status(204).build();
        }

        private Response userById(String path, String method, String body) {
            String[] parts = path.split("/");
            UUID id;
            try {
                if (path.endsWith("/reset-password")) {
                    id = UUID.fromString(parts[parts.length - 2]);
                } else {
                    id = UUID.fromString(parts[parts.length - 1]);
                }
            } catch (IllegalArgumentException ex) {
                return json(404, "{\"error\":\"not_found\"}");
            }
            boolean passwordReset = path.endsWith("/reset-password");
            TestUser user = byId.get(id);
            if (user == null) {
                return json(404, "{\"error\":\"not_found\"}");
            }
            if (passwordReset && method.equals("PUT")) {
                Map<String, Object> payload = readMap(body);
                user.password = string(payload.get("value"));
                return Response.response().status(204).build();
            }
            if (method.equals("PUT")) {
                if (failUserUpdates) {
                    return json(503, "{\"error\":\"service_unavailable\"}");
                }
                Map<String, Object> payload = readMap(body);
                if (payload.containsKey("enabled")) {
                    user.enabled = Boolean.TRUE.equals(payload.get("enabled"));
                }
                if (payload.containsKey("emailVerified")) {
                    user.emailVerified = Boolean.TRUE.equals(payload.get("emailVerified"));
                }
                String firstName = string(payload.get("firstName"));
                if (firstName != null && !firstName.isBlank()) {
                    user.name = firstName;
                }
                return Response.response().status(204).build();
            }
            if (method.equals("DELETE")) {
                byEmail.remove(user.email);
                byId.remove(user.id);
                return Response.response().status(204).build();
            }
            return json(200, toJson(userJson(user)));
        }

        private Map<String, Object> userJson(TestUser user) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("id", user.id.toString());
            payload.put("username", user.email);
            payload.put("email", user.email);
            payload.put("firstName", user.name);
            payload.put("lastName", user.name);
            payload.put("enabled", user.enabled);
            payload.put("emailVerified", user.emailVerified);
            return payload;
        }

        private String accessToken(TestUser user) {
            Map<String, Object> header = new LinkedHashMap<>();
            header.put("alg", "RS256");
            header.put("typ", "JWT");
            header.put("kid", KID);
            long now = Instant.now().getEpochSecond();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("iss", issuer());
            payload.put("aud", List.of("krug-api", "account"));
            payload.put("azp", "krug-web");
            payload.put("sub", user.id.toString());
            payload.put("typ", "Bearer");
            payload.put("iat", now);
            payload.put("nbf", now - 5);
            payload.put("exp", now + 900);
            payload.put("email", user.email);
            payload.put("email_verified", true);
            payload.put("preferred_username", user.email);
            payload.put("given_name", user.name);
            payload.put("family_name", user.name);
            payload.put("name", user.name + " " + user.name);
            payload.put("jti", UUID.randomUUID().toString());
            String signingInput = base64Url(toJson(header)) + "." + base64Url(toJson(payload));
            try {
                Signature signature = Signature.getInstance("SHA256withRSA");
                signature.initSign(KEY_PAIR.getPrivate());
                signature.update(signingInput.getBytes(StandardCharsets.US_ASCII));
                return signingInput + "." + base64Url(signature.sign());
            } catch (Exception ex) {
                throw new IllegalStateException("Test JWT signing failed", ex);
            }
        }

        private String jwks() {
            Map<String, Object> key = new LinkedHashMap<>();
            key.put("kty", "RSA");
            key.put("kid", KID);
            key.put("use", "sig");
            key.put("alg", "RS256");
            var rsa = (java.security.interfaces.RSAPublicKey) KEY_PAIR.getPublic();
            key.put("n", base64Url(unsigned(rsa.getModulus().toByteArray())));
            key.put("e", base64Url(unsigned(rsa.getPublicExponent().toByteArray())));
            return toJson(Map.of("keys", List.of(key)));
        }

        private Response json(int status, String body) {
            return Response.response()
                    .status(status)
                    .headers(new HttpHeaders(new HttpHeader("Content-Type", "application/json")))
                    .body(body)
                    .build();
        }

        private Map<String, Object> readMap(String body) {
            try {
                return MAPPER.readValue(body,
                        new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {
                        });
            } catch (Exception ex) {
                throw new IllegalStateException(ex);
            }
        }

        private String toJson(Object value) {
            try {
                return MAPPER.writeValueAsString(value);
            } catch (Exception ex) {
                throw new IllegalStateException(ex);
            }
        }

        private static String path(String url) {
            return URI.create("http://localhost" + url).getPath();
        }

        private static String query(String url, String name) {
            String query = URI.create("http://localhost" + url).getRawQuery();
            if (query == null) {
                return null;
            }
            for (String pair : query.split("&")) {
                String[] parts = pair.split("=", 2);
                if (parts.length == 2 && parts[0].equals(name)) {
                    return URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
                }
            }
            return null;
        }

        private static Map<String, String> parseForm(String body) {
            Map<String, String> form = new LinkedHashMap<>();
            if (body == null || body.isBlank()) {
                return form;
            }
            for (String pair : body.split("&")) {
                String[] parts = pair.split("=", 2);
                String key = URLDecoder.decode(parts[0], StandardCharsets.UTF_8);
                String value = parts.length == 2
                        ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "";
                form.put(key, value);
            }
            return form;
        }

        private static String bearer(String authorization) {
            if (authorization == null || !authorization.startsWith("Bearer ")) {
                return null;
            }
            return authorization.substring("Bearer ".length()).strip();
        }

        private static String string(Object value) {
            return value == null ? null : String.valueOf(value);
        }
    }

    private static KeyPair generateKeyPair() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            return generator.generateKeyPair();
        } catch (Exception ex) {
            throw new IllegalStateException("Cannot generate the test RSA key", ex);
        }
    }

    private static byte[] unsigned(byte[] encoded) {
        if (encoded.length > 0 && encoded[0] == 0) {
            byte[] trimmed = new byte[encoded.length - 1];
            System.arraycopy(encoded, 1, trimmed, 0, trimmed.length);
            return trimmed;
        }
        return encoded;
    }

    private static String base64Url(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static String base64Url(String value) {
        return base64Url(value.getBytes(StandardCharsets.UTF_8));
    }
}
