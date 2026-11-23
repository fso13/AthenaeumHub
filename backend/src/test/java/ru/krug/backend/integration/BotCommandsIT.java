package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
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
import ru.krug.backend.bot.application.service.BotResponseTokens;
import ru.krug.backend.bot.application.usecase.BotEventDeliveryService;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/** #98 slash commands and the one-time response capability. */
@ActiveProfiles("test")
class BotCommandsIT extends IntegrationTestBase {

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
        lenient().when(hostResolver.resolve(anyString())).thenAnswer(invocation ->
                List.of(InetAddress.getByName("93.184.216.34")));
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
    void invokesCommandWithoutChatMessageAndRespondsExactlyOnce() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("cmd-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Helper Bot", "deploy");
        install(owner, chatId, botId);
        patchEventsAndCommands(owner, workspaceId, botId, "deploy");

        long before = messageCount(chatId);
        MvcResult accepted = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/commands", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("command", "deploy",
                                "args", "production"))))
                .andExpect(status().isAccepted())
                .andReturn();
        JsonNode acceptedBody = json(accepted);
        CONTRACT.assertValid("BotCommandAccepted", acceptedBody);
        assertThat(acceptedBody.get("delivery_id").asText()).isNotBlank();
        // Slash-command invocation itself never writes a chat message.
        assertThat(messageCount(chatId)).isEqualTo(before);

        assertThat(deliveryService.deliverDue()).isEqualTo(1);
        assertThat(requests).hasSize(1);
        JsonNode slash = objectMapper.readTree(requests.get(0).body());
        assertThat(slash.get("type").asText()).isEqualTo("slash_command");
        assertThat(slash.get("command").asText()).isEqualTo("deploy");
        assertThat(slash.get("args").asText()).isEqualTo("production");
        assertThat(slash.get("chat_id").asText()).isEqualTo(chatId.toString());
        String responseUrl = slash.get("response_url").asText();
        assertThat(responseUrl).startsWith("http://localhost:8081/api/v1/bot-responses/");
        String token = responseUrl.substring(responseUrl.lastIndexOf('/') + 1);

        // The capability token itself authorises exactly one bot message (no JWT, no bearer).
        MvcResult responded = mockMvc.perform(post("/api/v1/bot-responses/{token}", token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "text", "deployed to production"))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode message = json(responded);
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("sender_type").asText()).isEqualTo("BOT");
        assertThat(message.get("bot_id").asText()).isEqualTo(botId.toString());
        assertThat(message.get("sender_id").isNull()).isTrue();
        assertThat(message.get("text").asText()).isEqualTo("deployed to production");
        assertThat(messageCount(chatId)).isEqualTo(before + 1);

        // One-time: the same capability is a conflict, never a second message.
        assertError(mockMvc.perform(post("/api/v1/bot-responses/{token}", token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("text", "again")))),
                409, "BOT_RESPONSE_USED");
        assertThat(messageCount(chatId)).isEqualTo(before + 1);

        // A malformed/unknown token is a generic 401.
        assertError(mockMvc.perform(post("/api/v1/bot-responses/{token}",
                        "sova_resp_not-a-token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("text", "x")))),
                401, "BOT_RESPONSE_INVALID");
    }

    @Test
    void slashCommandWorksWithoutMessageEventSubscriptions() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("cmd-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Command Only", "deploy");
        install(owner, chatId, botId);

        // Events list may be empty: a webhook can serve slash commands only.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("events_url", EVENTS_URL);
        body.put("events", List.of());
        body.put("events_enabled", true);
        body.put("commands", List.of(Map.of("command", "deploy",
                "description", "Deploy")));
        mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}", workspaceId, botId),
                        owner).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk());

        invoke(owner, chatId, "deploy", "");
        assertThat(deliveryService.deliverDue()).isEqualTo(1);
        assertThat(objectMapper.readTree(requests.get(0).body()).get("type").asText())
                .isEqualTo("slash_command");
    }

    @Test
    void expiredResponseTokenIsGone() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("cmd-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Helper Bot", "status");
        install(owner, chatId, botId);
        patchEventsAndCommands(owner, workspaceId, botId, "status");

        invoke(owner, chatId, "status", "");
        deliveryService.deliverDue();
        String token = tokenFromLastSlashCommand();
        UUID tokenId = BotResponseTokens.parse(token).orElseThrow().tokenId();
        migrator().update("""
                UPDATE bot.command_tokens SET expires_at = now() - interval '1 second'
                 WHERE id = ?
                """, tokenId);

        assertError(mockMvc.perform(post("/api/v1/bot-responses/{token}", token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("text", "late")))),
                410, "BOT_RESPONSE_EXPIRED");
    }

    @Test
    void commandRequiresActiveChatMemberInstalledBotAndUnambiguousRegistration()
            throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("cmd-owner"));
        SessionResponse member = devSession(uniqueDisplayName("cmd-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(workspaceId, member.user().id(), "MEMBER");
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        SessionResponse memberScoped = scoped(member, workspaceId);
        UUID botId = createBot(owner, workspaceId, "Helper Bot", "deploy");
        install(owner, chatId, botId);
        patchEventsAndCommands(owner, workspaceId, botId, "deploy");

        // Any active chat member (not only a chat admin) may invoke the command.
        invoke(memberScoped, chatId, "deploy", "");

        // Unknown command is a 404.
        assertError(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/commands", chatId), memberScoped)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "command", "missing")))), 404, "BOT_COMMAND_NOT_FOUND");

        // A workspace member who is not in the chat cannot see it.
        SessionResponse outsider = devSession(uniqueDisplayName("cmd-outsider"));
        assertError(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/commands", chatId), outsider)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "command", "deploy")))), 404, null);

        // A second installed bot owning the same command makes the invocation ambiguous.
        UUID secondBot = createBot(owner, workspaceId, "Other Bot", "deploy");
        install(owner, chatId, secondBot);
        patchEventsAndCommands(owner, workspaceId, secondBot, "deploy");
        assertError(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/commands", chatId), memberScoped)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "command", "deploy")))), 409, "BOT_COMMAND_AMBIGUOUS");
    }

    @Test
    void commandIsRejectedInE2eeChatAndWithoutEventEndpoint() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("cmd-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID botId = createBot(owner, workspaceId, "Helper Bot", "deploy");
        install(owner, chatId, botId);

        // Registered command, but no events_url/secret: the webhook cannot be delivered.
        mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}", workspaceId, botId),
                        owner).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("commands",
                                List.of(Map.of("command", "deploy",
                                        "description", "Deploy"))))))
                .andExpect(status().isOk());
        assertError(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/commands", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "command", "deploy")))), 422, "BOT_EVENTS_NOT_CONFIGURED");

        // E2EE chats never host a bot command.
        UUID e2eeChatId = createE2eeChat(workspaceId, owner.user().id());
        assertError(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/commands", e2eeChatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "command", "deploy")))), 422, "BOT_E2EE_UNSUPPORTED");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private UUID createBot(SessionResponse session, UUID workspaceId, String name,
                           String command) throws Exception {
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

    private void patchEventsAndCommands(SessionResponse session, UUID workspaceId, UUID botId,
                                        String command) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("events_url", EVENTS_URL);
        body.put("events", List.of("message.created"));
        body.put("events_enabled", true);
        body.put("commands", List.of(Map.of("command", command,
                "description", "Runs " + command)));
        mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}", workspaceId, botId),
                        session).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk());
    }

    private void invoke(SessionResponse session, UUID chatId, String command, String args)
            throws Exception {
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/commands", chatId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("command", command,
                                "args", args))))
                .andExpect(status().isAccepted());
    }

    private String tokenFromLastSlashCommand() throws Exception {
        JsonNode slash = objectMapper.readTree(
                requests.get(requests.size() - 1).body());
        String responseUrl = slash.get("response_url").asText();
        return responseUrl.substring(responseUrl.lastIndexOf('/') + 1);
    }

    private void joinWorkspace(UUID workspaceId, UUID userId, String role) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'ACTIVE')
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE'
                """, workspaceId, userId, role);
    }

    private void joinChat(UUID chatId, UUID workspaceId, UUID userId, String role) {
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, ?, 'ACTIVE')
                ON CONFLICT (chat_id, user_id)
                DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE'
                """, chatId, workspaceId, userId, role);
    }

    private SessionResponse scoped(SessionResponse session, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), session.device().id(),
                workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                session.device(),
                new SessionResponse.WorkspaceInfo(workspaceId, "ws", "MANAGED"),
                session.chat());
    }

    private UUID createE2eeChat(UUID workspaceId, UUID ownerId) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'E2EE', 'e2ee-command-test', ?)
                """, chatId, workspaceId, ownerId);
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, chatId, workspaceId, ownerId);
        return chatId;
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
