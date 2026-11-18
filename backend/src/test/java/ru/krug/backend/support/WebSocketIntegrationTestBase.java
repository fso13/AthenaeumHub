package ru.krug.backend.support;

import java.util.UUID;

import javax.sql.DataSource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;

import ru.krug.backend.ops.api.dto.SessionResponse;

/**
 * Real HTTP server (RANDOM_PORT) + WS client base. Reuses the PostgreSQL container started
 * by {@link IntegrationTestBase} so the suite runs a single database.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
public abstract class WebSocketIntegrationTestBase {

    private static final PostgreSQLContainer<?> POSTGRES = IntegrationTestBase.POSTGRES;
    private static JdbcTemplate migratorJdbc;

    @LocalServerPort
    protected int port;

    @Autowired
    protected TestRestTemplate rest;

    @Autowired
    protected ObjectMapper objectMapper;

    @DynamicPropertySource
    static void databaseProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "krug_app");
        registry.add("spring.datasource.password", () -> "krug_app");
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.datasource.hikari.initialization-fail-timeout", () -> "-1");
    }

    protected String url(String path) {
        return "http://localhost:" + port + path;
    }

    protected synchronized JdbcTemplate migrator() {
        if (migratorJdbc == null) {
            DataSource dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
            migratorJdbc = new JdbcTemplate(dataSource);
        }
        return migratorJdbc;
    }

    protected SessionResponse devSession() throws Exception {
        return devSession("user-" + UUID.randomUUID().toString().substring(0, 12));
    }

    protected SessionResponse devSession(String displayName) throws Exception {
        HttpHeaders headers = jsonHeaders();
        String body = objectMapper.writeValueAsString(java.util.Map.of("display_name", displayName));
        ResponseEntity<String> response = rest.exchange(url("/api/v1/dev/session"), HttpMethod.POST,
                new HttpEntity<>(body, headers), String.class);
        if (response.getStatusCode().value() != 200 || response.getBody() == null) {
            throw new IllegalStateException("dev/session failed: " + response.getStatusCode());
        }
        return objectMapper.readValue(response.getBody(), SessionResponse.class);
    }

    protected JsonNode ticket(SessionResponse session) throws Exception {
        HttpHeaders headers = authHeaders(session);
        ResponseEntity<String> response = rest.exchange(url("/api/v1/realtime/ticket"),
                HttpMethod.POST, new HttpEntity<>(headers), String.class);
        if (response.getStatusCode().value() != 200) {
            throw new IllegalStateException("ticket failed: " + response.getStatusCode()
                    + " " + response.getBody());
        }
        return objectMapper.readTree(response.getBody());
    }

    protected JsonNode sendMessage(SessionResponse session, UUID chatId, String text,
                                   String clientMessageId) throws Exception {
        return sendMessage(session, chatId, text, clientMessageId, null);
    }

    protected JsonNode sendMessage(SessionResponse session, UUID chatId, String text,
                                   String clientMessageId, UUID threadRootId) throws Exception {
        HttpHeaders headers = authHeaders(session);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("client_message_id", clientMessageId);
        body.put("type", "TEXT");
        body.put("text", text);
        if (threadRootId != null) {
            body.put("thread_root_id", threadRootId.toString());
        }
        ResponseEntity<String> response = rest.exchange(
                url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.POST,
                new HttpEntity<>(objectMapper.writeValueAsString(body), headers), String.class);
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("send failed: " + response.getStatusCode()
                    + " " + response.getBody());
        }
        return objectMapper.readTree(response.getBody());
    }

    protected JsonNode sendSticker(SessionResponse session, UUID chatId, UUID stickerId,
                                   String clientMessageId) throws Exception {
        HttpHeaders headers = authHeaders(session);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("client_message_id", clientMessageId);
        body.put("type", "STICKER");
        body.put("sticker_id", stickerId.toString());
        ResponseEntity<String> response = rest.exchange(
                url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.POST,
                new HttpEntity<>(objectMapper.writeValueAsString(body), headers), String.class);
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("sticker send failed: " + response.getStatusCode()
                    + " " + response.getBody());
        }
        return objectMapper.readTree(response.getBody());
    }

    protected ResponseEntity<String> markRead(SessionResponse session, UUID chatId, long lastSeq) {
        HttpHeaders headers = authHeaders(session);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        return rest.exchange(url("/api/v1/chats/" + chatId + "/read"), HttpMethod.POST,
                new HttpEntity<>("{\"last_seq\":" + lastSeq + "}", headers), String.class);
    }

    protected HttpHeaders authHeaders(SessionResponse session) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(session.accessToken());
        headers.add("X-Device-Id", session.device().id().toString());
        return headers;
    }

    protected HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    protected JsonNode json(String body) throws Exception {
        return objectMapper.readTree(body);
    }
}
