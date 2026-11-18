package ru.krug.backend.support;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import javax.sql.DataSource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;

/**
 * Shared PostgreSQL 16 Testcontainer. Flyway runs as the container superuser and creates the
 * krug_app RLS role; the application connects as krug_app exactly like in dev.
 */
@SpringBootTest
@AutoConfigureMockMvc
public abstract class IntegrationTestBase {

    public static final PostgreSQLContainer<?> POSTGRES =
            new PostgreSQLContainer<>("postgres:16-alpine")
                    .withDatabaseName("krug")
                    .withUsername("krug_migrator")
                    .withPassword("krug_migrator");

    static {
        POSTGRES.start();
    }

    private static JdbcTemplate migratorJdbc;

    @Autowired
    protected MockMvc mockMvc;
    @Autowired
    protected ObjectMapper objectMapper;
    @Autowired
    protected JdbcTemplate jdbc;
    @Autowired
    protected DataSource dataSource;
    @Autowired
    protected RequestCanonicalizer canonicalizer;

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

    /** Superuser connection for fixtures/assertions that must bypass RLS. */
    protected synchronized JdbcTemplate migrator() {
        if (migratorJdbc == null) {
            DriverManagerDataSource dataSource = new DriverManagerDataSource(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
            migratorJdbc = new JdbcTemplate(dataSource);
        }
        return migratorJdbc;
    }

    /**
     * Runs JDBC work under an explicit RLS context using a plain DataSource transaction
     * (independent of the application JPA transaction manager).
     */
    protected <T> T inTenant(UUID userId, UUID workspaceId, Supplier<T> work) {
        TransactionTemplate template = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        return template.execute(status -> {
            jdbc.query("SELECT set_config('app.user_id', ?, true),"
                            + " set_config('app.workspace_id', ?, true),"
                            + " set_config('app.request_id', ?, true)",
                    (RowCallbackHandler) rs -> { },
                    userId.toString(), workspaceId.toString(), "integration-test");
            return work.get();
        });
    }

    protected SessionResponse devSession() throws Exception {
        return devSession(uniqueDisplayName("user"));
    }

    protected SessionResponse devSession(String displayName) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/dev/session")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("display_name", displayName))))
                .andReturn();
        if (result.getResponse().getStatus() != 200) {
            throw new IllegalStateException("dev/session failed: "
                    + result.getResponse().getStatus() + " " + result.getResponse().getContentAsString());
        }
        return objectMapper.readValue(result.getResponse().getContentAsString(), SessionResponse.class);
    }

    protected static String uniqueDisplayName(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 12);
    }

    protected MockHttpServletRequestBuilder authed(MockHttpServletRequestBuilder builder,
                                                   SessionResponse session) {
        return builder.header("Authorization", "Bearer " + session.accessToken())
                .header("X-Device-Id", session.device().id().toString());
    }

    protected JsonNode json(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString());
    }

    protected JsonNode sendMessage(SessionResponse session, UUID chatId, String idempotencyKey,
                                   String clientMessageId, String text) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", idempotencyKey)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientMessageId, text, null)))
                .andReturn();
        if (result.getResponse().getStatus() != 201) {
            throw new IllegalStateException("send failed: " + result.getResponse().getStatus()
                    + " " + result.getResponse().getContentAsString());
        }
        return json(result);
    }

    protected String messageBody(String clientMessageId, String text, UUID replyToId) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", clientMessageId);
        body.put("type", "TEXT");
        body.put("text", text);
        if (replyToId != null) {
            body.put("reply_to_id", replyToId.toString());
        }
        return objectMapper.writeValueAsString(body);
    }

    protected JsonNode chatList(SessionResponse session) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/chats", session.workspace().id()), session))
                .andReturn();
        if (result.getResponse().getStatus() != 200) {
            throw new IllegalStateException("chat list failed: " + result.getResponse().getStatus());
        }
        return json(result);
    }

    protected long messageCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM message.messages WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    protected JsonNode stickerPacks(SessionResponse session, UUID chatId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/sticker-packs").param("chat_id", chatId.toString()), session))
                .andReturn();
        if (result.getResponse().getStatus() != 200) {
            throw new IllegalStateException("sticker packs failed: "
                    + result.getResponse().getStatus() + " "
                    + result.getResponse().getContentAsString());
        }
        return json(result);
    }

    protected ResultActions favorite(SessionResponse session, UUID stickerId) throws Exception {
        return mockMvc.perform(authed(
                put("/api/v1/stickers/{stickerId}/favorite", stickerId), session));
    }

    protected ResultActions unfavorite(SessionResponse session, UUID stickerId) throws Exception {
        return mockMvc.perform(authed(
                delete("/api/v1/stickers/{stickerId}/favorite", stickerId), session));
    }

    protected MvcResult sendSticker(SessionResponse session, UUID chatId, UUID stickerId,
                                    String clientMessageId, String idempotencyKey) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", idempotencyKey)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "client_message_id", clientMessageId,
                                "type", "STICKER",
                                "sticker_id", stickerId.toString()))))
                .andReturn();
    }
}
