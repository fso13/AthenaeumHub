package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.InetAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.bot.application.port.BotEventTransport;
import ru.krug.backend.bot.application.port.BotHostResolver;
import ru.krug.backend.bot.application.service.BotSignatures;
import ru.krug.backend.bot.application.usecase.BotEventDeliveryService;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/** #98 signed bot events: signature, app_mention, retry/backoff, SSRF, permissions, dedupe. */
@ActiveProfiles("test")
class BotEventsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String EVENTS_URL = "https://events.example.test/hooks/sova";

    @MockBean
    private BotEventTransport transport;
    @MockBean
    private BotHostResolver hostResolver;
    @Autowired
    private BotEventDeliveryService deliveryService;
    @Autowired
    private TokenIssuer tokenIssuer;

    private final List<Captured> requests = new ArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        // deliverDue() drains the cross-tenant outbox; keep each test's queue isolated.
        migrator().update("DELETE FROM bot.event_deliveries");
        lenient().when(hostResolver.resolve(anyString())).thenAnswer(invocation -> {
            String host = invocation.getArgument(0);
            if ("127.0.0.1".equals(host)) {
                return List.of(InetAddress.getByName("127.0.0.1"));
            }
            return List.of(InetAddress.getByName("93.184.216.34"));
        });
        lenient().when(transport.send(any(), anyMap(), any(byte[].class)))
                .thenAnswer(invocation -> {
                    URI uri = invocation.getArgument(0);
                    Map<String, String> headers = invocation.getArgument(1);
                    byte[] body = invocation.getArgument(2);
                    requests.add(new Captured(uri, Map.copyOf(headers), body.clone()));
                    return BotEventTransport.BotEventTransportResult.delivered(200);
                });
    }

    @Test
    void signedMessageCreatedDeliveryIsVerifiableAndReplaySafe() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("events-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Deploy Bot");
        install(owner, chatId, botId);

        JsonNode patched = patchEvents(owner, workspaceId, botId, EVENTS_URL,
                List.of("message.created"));
        CONTRACT.assertValid("Bot", patched);
        assertThat(patched.get("has_signing_secret").asBoolean()).isTrue();
        String secret = patched.get("signing_secret").asText();
        assertThat(secret).startsWith("sova_whsec_");
        // Only the AES-GCM ciphertext is stored; the raw signing secret is never a column.
        Map<String, Object> storedSecret = migrator().queryForMap("""
                SELECT encode(signing_secret_encrypted, 'base64') AS ciphertext,
                       signing_secret_created_at
                  FROM bot.bots WHERE id = ?
                """, botId);
        assertThat((String) storedSecret.get("ciphertext")).doesNotContain(secret);
        assertThat(storedSecret.get("signing_secret_created_at")).isNotNull();

        String key = UUID.randomUUID().toString();
        String clientMessageId = UUID.randomUUID().toString();
        send(owner, chatId, key, clientMessageId, "build #98 is green", false);
        assertThat(deliveryService.deliverDue()).isEqualTo(1);
        assertThat(requests).hasSize(1);

        Captured capture = requests.get(0);
        assertThat(capture.uri()).isEqualTo(URI.create(EVENTS_URL));
        assertThat(capture.headers().get("X-Sova-Event-Type")).isEqualTo("message.created");
        assertThat(capture.headers().get("X-Sova-Event-Id")).isNotBlank();
        long timestamp = Long.parseLong(capture.headers().get("X-Sova-Timestamp"));
        assertThat(capture.headers().get("X-Sova-Signature"))
                .isEqualTo(BotSignatures.sign(secret, timestamp, capture.body()));

        JsonNode envelope = objectMapper.readTree(capture.body());
        assertThat(envelope.get("type").asText()).isEqualTo("message.created");
        assertThat(envelope.get("workspace_id").asText()).isEqualTo(workspaceId.toString());
        assertThat(envelope.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(envelope.get("message").get("text").asText())
                .isEqualTo("build #98 is green");

        // Idempotent replay returns the same message and adds no second delivery.
        MvcResult replay = send(owner, chatId, key, clientMessageId,
                "build #98 is green", false);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(deliveryService.deliverDue()).isZero();
        assertThat(countDeliveries(botId, "message.created")).isEqualTo(1);

        MvcResult deliveries = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/bots/{botId}/deliveries",
                                workspaceId, botId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode list = json(deliveries);
        CONTRACT.assertValid("BotDeliveryList", list);
        assertThat(list.get("items")).hasSize(1);
        assertThat(list.get("items").get(0).get("status").asText()).isEqualTo("DELIVERED");
        assertThat(list.get("items").get(0).has("payload")).isFalse();
    }

    @Test
    void appMentionFiresForTextMentionAndForServerValidatedAll() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("events-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Mention Bot");
        install(owner, chatId, botId);
        patchEvents(owner, workspaceId, botId, EVENTS_URL, List.of("app_mention"));

        send(owner, chatId, UUID.randomUUID().toString(), "hey @Mention Bot deploy", false);
        deliveryService.deliverDue();
        assertThat(requests).hasSize(1);
        assertThat(objectMapper.readTree(requests.get(0).body()).get("type").asText())
                .isEqualTo("app_mention");

        // @all is a server-validated flag; every app_mention-subscribed bot receives it.
        send(owner, chatId, UUID.randomUUID().toString(), "heads up", true);
        deliveryService.deliverDue();
        assertThat(requests).hasSize(2);
        assertThat(objectMapper.readTree(requests.get(1).body()).get("type").asText())
                .isEqualTo("app_mention");

        // A plain message does not trigger app_mention.
        send(owner, chatId, UUID.randomUUID().toString(), "just chatting", false);
        assertThat(deliveryService.deliverDue()).isZero();
        assertThat(countDeliveries(botId, "app_mention")).isEqualTo(2);
    }

    @Test
    void retriesWithBackoffUntilSuccess() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("events-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Retry Bot");
        install(owner, chatId, botId);
        patchEvents(owner, workspaceId, botId, EVENTS_URL, List.of("message.created"));

        when(transport.send(any(), anyMap(), any(byte[].class)))
                .thenReturn(BotEventTransport.BotEventTransportResult.failed(500,
                                "http_500", true),
                        BotEventTransport.BotEventTransportResult.failed(500, "http_500", true),
                        BotEventTransport.BotEventTransportResult.delivered(200));

        send(owner, chatId, UUID.randomUUID().toString(), "retry me", false);
        assertThat(deliveryService.deliverDue()).isEqualTo(1);
        Map<String, Object> afterFirst = deliveryRow(botId);
        assertThat(afterFirst.get("status")).isEqualTo("PENDING");
        assertThat(((Number) afterFirst.get("attempt_count")).intValue()).isEqualTo(1);
        assertThat(afterFirst.get("last_status_code")).isEqualTo(500);

        makeDue(botId);
        deliveryService.deliverDue();
        Map<String, Object> afterSecond = deliveryRow(botId);
        assertThat(afterSecond.get("status")).isEqualTo("PENDING");
        assertThat(((Number) afterSecond.get("attempt_count")).intValue()).isEqualTo(2);

        makeDue(botId);
        deliveryService.deliverDue();
        Map<String, Object> afterThird = deliveryRow(botId);
        assertThat(afterThird.get("status")).isEqualTo("DELIVERED");
        assertThat(afterThird.get("delivered_at")).isNotNull();
        verify(transport, org.mockito.Mockito.times(3)).send(any(), anyMap(),
                any(byte[].class));
    }

    @Test
    void ssrfGuardRejectsPrivateTargetAtSendTime() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("events-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "SSRF Bot");
        install(owner, chatId, botId);
        patchEvents(owner, workspaceId, botId, "https://127.0.0.1/internal",
                List.of("message.created"));

        send(owner, chatId, UUID.randomUUID().toString(), "blocked", false);
        assertThat(deliveryService.deliverDue()).isEqualTo(1);

        Map<String, Object> row = deliveryRow(botId);
        assertThat(row.get("status")).isEqualTo("FAILED");
        assertThat(row.get("last_error")).isEqualTo("private_address");
        verify(transport, never()).send(any(), anyMap(), any(byte[].class));
    }

    @Test
    void redirectIsPermanentAndNeverFollowedByTheTransport() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("events-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Redirect Bot");
        install(owner, chatId, botId);
        patchEvents(owner, workspaceId, botId, EVENTS_URL, List.of("message.created"));
        when(transport.send(any(), anyMap(), any(byte[].class)))
                .thenReturn(BotEventTransport.BotEventTransportResult.failed(302,
                        "redirect_not_allowed", false));

        send(owner, chatId, UUID.randomUUID().toString(), "redirect", false);
        deliveryService.deliverDue();
        Map<String, Object> row = deliveryRow(botId);
        assertThat(row.get("status")).isEqualTo("FAILED");
        assertThat(row.get("last_status_code")).isEqualTo(302);
        assertThat(row.get("last_error")).isEqualTo("redirect_not_allowed");
    }

    @Test
    void eventAdministrationRequiresWorkspaceManagerAndTestEventPings() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("events-owner"));
        SessionResponse member = devSession(uniqueDisplayName("events-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(workspaceId, member.user().id(), "MEMBER");
        SessionResponse memberScoped = scoped(member, workspaceId);
        UUID botId = createBot(owner, workspaceId, "Ping Bot");
        install(owner, chatId, botId);

        assertError(mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}", workspaceId, botId),
                        memberScoped).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "events_url", EVENTS_URL)))), 403,
                "WORKSPACE_PERMISSION_DENIED");
        assertError(mockMvc.perform(authed(get(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}/deliveries",
                        workspaceId, botId), memberScoped)), 403,
                "WORKSPACE_PERMISSION_DENIED");
        assertError(mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}/secret",
                        workspaceId, botId), memberScoped)), 403,
                "WORKSPACE_PERMISSION_DENIED");
        assertError(mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}/test-event",
                        workspaceId, botId), memberScoped)), 403,
                "WORKSPACE_PERMISSION_DENIED");

        // No events_url/secret yet: a ping is an explicit 422, not a silent no-op.
        assertError(mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}/test-event",
                        workspaceId, botId), owner)), 422, "BOT_EVENTS_NOT_CONFIGURED");

        patchEvents(owner, workspaceId, botId, EVENTS_URL, List.of("message.created"));
        MvcResult accepted = mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}/test-event",
                        workspaceId, botId), owner))
                .andExpect(status().isAccepted())
                .andReturn();
        CONTRACT.assertValid("BotDeliveryAccepted", json(accepted));
        assertThat(deliveryService.deliverDue()).isEqualTo(1);
        assertThat(requests).hasSize(1);
        assertThat(objectMapper.readTree(requests.get(0).body()).get("type").asText())
                .isEqualTo("test");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private UUID createBot(SessionResponse session, UUID workspaceId, String name)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/bots", workspaceId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", name,
                                "scopes", List.of("chat.write")))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("bot").get("id").asText());
    }

    private void install(SessionResponse session, UUID chatId, UUID botId) throws Exception {
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", chatId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("bot_id", botId))))
                .andExpect(status().isCreated());
    }

    private JsonNode patchEvents(SessionResponse session, UUID workspaceId, UUID botId,
                                 String url, List<String> events) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("events_url", url);
        body.put("events", events);
        body.put("events_enabled", true);
        MvcResult result = mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}", workspaceId, botId),
                        session).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private MvcResult send(SessionResponse session, UUID chatId, String idempotencyKey,
                           String text, boolean mentionAll) throws Exception {
        return send(session, chatId, idempotencyKey, UUID.randomUUID().toString(), text,
                mentionAll);
    }

    private MvcResult send(SessionResponse session, UUID chatId, String idempotencyKey,
                           String clientMessageId, String text, boolean mentionAll)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", clientMessageId);
        body.put("type", "TEXT");
        body.put("text", text);
        if (mentionAll) {
            body.put("mention_all", true);
        }
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", idempotencyKey)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())
                .andReturn();
        return result;
    }

    private int countDeliveries(UUID botId, String eventType) {
        Integer count = migrator().queryForObject("""
                SELECT count(*) FROM bot.event_deliveries
                 WHERE bot_id = ? AND event_type = ?
                """, Integer.class, botId, eventType);
        return count == null ? 0 : count;
    }

    private Map<String, Object> deliveryRow(UUID botId) {
        return migrator().queryForMap("""
                SELECT status, attempt_count, last_status_code, last_error, delivered_at
                  FROM bot.event_deliveries WHERE bot_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, botId);
    }

    private void makeDue(UUID botId) {
        migrator().update("""
                UPDATE bot.event_deliveries
                   SET next_attempt_at = now() - interval '1 second'
                 WHERE bot_id = ? AND status = 'PENDING'
                """, botId);
    }

    private SessionResponse scoped(SessionResponse session, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), session.device().id(),
                workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                session.device(),
                new SessionResponse.WorkspaceInfo(workspaceId, "ws", "MANAGED"),
                session.chat());
    }

    private void joinWorkspace(UUID workspaceId, UUID userId, String role) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'ACTIVE')
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE'
                """, workspaceId, userId, role);
    }

    private void assertError(org.springframework.test.web.servlet.ResultActions actions,
                             int status, String code) throws Exception {
        assertError(actions.andReturn(), status, code);
    }

    private void assertError(MvcResult result, int status, String code) throws Exception {
        assertThat(result.getResponse().getStatus()).isEqualTo(status);
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        if (code != null) {
            assertThat(body.get("code").asText()).isEqualTo(code);
        }
    }

    private record Captured(URI uri, Map<String, String> headers, byte[] body) {
    }
}
