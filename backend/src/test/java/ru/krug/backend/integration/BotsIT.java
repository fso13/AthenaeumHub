package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #96 bot MVP: create/one-time token/rotate, installation, bot send, permissions, revoked
 * token, no read/file/call surface, RLS and the UI contract.
 */
@ActiveProfiles("test")
class BotsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    // ------------------------------------------------------------------
    // Create / token lifecycle
    // ------------------------------------------------------------------

    @Test
    void createsBotReturnsTokenOnceAndListsWithoutCredentials() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        UUID workspaceId = owner.workspace().id();

        JsonNode created = createBot(owner, workspaceId, "  Deploy Bot  ");
        CONTRACT.assertValid("BotToken", created);
        String token = created.get("token").asText();
        String botId = created.get("bot").get("id").asText();
        assertThat(token).startsWith("sova_bot_");
        assertThat(created.get("bot").get("name").asText()).isEqualTo("Deploy Bot");
        assertThat(created.get("bot").get("status").asText()).isEqualTo("ACTIVE");
        assertThat(created.get("bot").get("scopes").get(0).asText()).isEqualTo("chat.write");

        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/bots", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(list);
        CONTRACT.assertValid("BotList", body);
        assertThat(body.get("items")).hasSize(1);
        CONTRACT.assertValid("Bot", body.get("items").get(0));
        assertThat(body.get("items").get(0).get("id").asText()).isEqualTo(botId);
        assertThat(body.get("items").get(0).has("token")).isFalse();
        assertThat(body.get("items").get(0).has("token_hash")).isFalse();
        assertThat(list.getResponse().getContentAsString()).doesNotContain(token);

        // Only the hash is stored; the raw token never enters a table column.
        Map<String, Object> stored = migrator().queryForMap("""
                SELECT encode(token_hash, 'hex') AS hash, octet_length(token_hash) AS len
                  FROM bot.bots WHERE id = ?
                """, UUID.fromString(botId));
        assertThat(stored.get("len")).isEqualTo(32);
        assertThat(stored.get("hash")).isNotEqualTo(token);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'bot' AND table_name = 'bots'
                   AND column_name IN ('token', 'raw_token', 'token_plain')
                """, Integer.class)).isZero();

        // Audit carries ids only: neither the token nor its hash is present.
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'bot.created' AND target_id = ?
                   AND metadata::text NOT LIKE ?
                """, Integer.class, UUID.fromString(botId), "%" + token + "%"))
                .isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'bot.created' AND target_id = ?
                   AND metadata::text LIKE '%chat.write%'
                """, Integer.class, UUID.fromString(botId))).isZero();
    }

    @Test
    void botManagementRequiresWorkspaceOwnerOrAdmin() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        SessionResponse member = devSession(uniqueDisplayName("bots-member"));
        SessionResponse admin = devSession(uniqueDisplayName("bots-admin"));
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(workspaceId, member.user().id(), "MEMBER");
        joinWorkspace(workspaceId, admin.user().id(), "ADMIN");
        SessionResponse memberScoped = scoped(member, workspaceId);
        SessionResponse adminScoped = scoped(admin, workspaceId);

        assertError(mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/bots",
                workspaceId), memberScoped).contentType(MediaType.APPLICATION_JSON)
                .content(botBody("member-bot", List.of("chat.write")))),
                403, "WORKSPACE_PERMISSION_DENIED");
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/bots", workspaceId),
                        memberScoped))
                .andExpect(status().isOk());
        JsonNode created = createBot(adminScoped, workspaceId, "admin-bot");
        assertThat(created.get("bot").get("id").asText()).isNotBlank();

        // An outsider belongs to no workspace and is hidden with 403.
        SessionResponse outsider = devSession(uniqueDisplayName("bots-outsider"));
        assertError(mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/bots",
                workspaceId), outsider)), 403, null);

        // Unsupported scope is a 400 with no row created.
        assertError(mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/bots",
                workspaceId), owner).contentType(MediaType.APPLICATION_JSON)
                .content(botBody("bad", List.of("chat.read")))), 400, "VALIDATION_FAILED");
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM bot.bots WHERE workspace_id = ?", Integer.class,
                workspaceId)).isEqualTo(1);
    }

    @Test
    void rotationInvalidatesTheOldTokenAndShowsTheNewOneOnce() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        JsonNode created = createBot(owner, workspaceId, "Rotate Bot");
        String botId = created.get("bot").get("id").asText();
        String oldToken = created.get("token").asText();
        install(owner, chatId, UUID.fromString(botId), 201);

        assertThat(botSend(oldToken, botId, chatId, UUID.randomUUID(), "before").getResponse()
                .getStatus()).isEqualTo(201);

        MvcResult rotated = mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}/token", workspaceId,
                        UUID.fromString(botId)), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode tokenBody = json(rotated);
        CONTRACT.assertValid("BotToken", tokenBody);
        String newToken = tokenBody.get("token").asText();
        assertThat(newToken).isNotEqualTo(oldToken);
        assertThat(tokenBody.get("bot").get("token_rotated_at").isNull()).isFalse();

        assertError(botSend(oldToken, botId, chatId, UUID.randomUUID(), "old"), 401,
                "UNAUTHENTICATED");
        assertThat(botSend(newToken, botId, chatId, UUID.randomUUID(), "new").getResponse()
                .getStatus()).isEqualTo(201);

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'bot.token.rotated' AND target_id = ?
                   AND metadata::text NOT LIKE ? AND metadata::text NOT LIKE ?
                """, Integer.class, UUID.fromString(botId), "%" + oldToken + "%",
                "%" + newToken + "%")).isEqualTo(1);
    }

    // ------------------------------------------------------------------
    // Installation
    // ------------------------------------------------------------------

    @Test
    void installationIsChatAdminOnlyIdempotentAndManagedOnly() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        SessionResponse member = devSession(uniqueDisplayName("bots-member"));
        SessionResponse wsAdmin = devSession(uniqueDisplayName("bots-wsadmin"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(workspaceId, member.user().id(), "MEMBER");
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        joinWorkspace(workspaceId, wsAdmin.user().id(), "ADMIN");
        SessionResponse memberScoped = scoped(member, workspaceId);
        SessionResponse wsAdminScoped = scoped(wsAdmin, workspaceId);

        JsonNode created = createBot(owner, workspaceId, "Helper");
        UUID botId = UUID.fromString(created.get("bot").get("id").asText());

        MvcResult installed = install(owner, chatId, botId, 201);
        CONTRACT.assertValid("ChatBot", json(installed));
        assertThat(json(installed).get("enabled").asBoolean()).isTrue();
        // Idempotent repeat: no second row, still a 201.
        install(owner, chatId, botId, 201);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM bot.chat_bots WHERE chat_id = ? AND bot_id = ?",
                Integer.class, chatId, botId)).isEqualTo(1);

        // A chat MEMBER and a workspace ADMIN who is not a chat member cannot manage bots.
        assertError(mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", chatId),
                memberScoped).contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("bot_id", botId)))), 403,
                "FORBIDDEN");
        assertError(mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", chatId),
                wsAdminScoped).contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("bot_id", botId)))), 404,
                "NOT_FOUND");

        // Members can read the installed list; it never exposes a credential.
        MvcResult list = mockMvc.perform(authed(get("/api/v1/chats/{chatId}/bots", chatId),
                        memberScoped))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("ChatBotList", json(list));
        assertThat(json(list).get("items")).hasSize(1);
        assertThat(json(list).get("items").get(0).get("bot").has("token")).isFalse();

        // E2EE chats never host a managed bot. The DB forbids a MANAGED->E2EE mode change,
        // so the chat is created as E2EE directly (as E2EE onboarding does).
        UUID e2eeChatId = createE2eeChat(workspaceId, owner.user().id());
        assertError(mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", e2eeChatId),
                        owner).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("bot_id", botId)))),
                422, "BOT_E2EE_UNSUPPORTED");

        // A disabled bot cannot be installed.
        mockMvc.perform(authed(delete("/api/v1/workspaces/{workspaceId}/bots/{botId}",
                        workspaceId, botId), owner))
                .andExpect(status().isNoContent());
        assertError(mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("bot_id", botId)))),
                422, "BOT_DISABLED");

        // Uninstall is chat-admin only and removes the installation.
        assertError(mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/bots/{botId}",
                chatId, botId), memberScoped)), 403, "FORBIDDEN");
        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/bots/{botId}", chatId, botId),
                        owner))
                .andExpect(status().isNoContent());
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM bot.chat_bots WHERE chat_id = ? AND bot_id = ?",
                Integer.class, chatId, botId)).isZero();
    }

    // ------------------------------------------------------------------
    // Bot message send
    // ------------------------------------------------------------------

    @Test
    void botSendsWithBadgeIdempotencyAndNoImpersonation() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        JsonNode created = createBot(owner, workspaceId, "Deploy Bot");
        String botId = created.get("bot").get("id").asText();
        String token = created.get("token").asText();
        UUID botUuid = UUID.fromString(botId);
        install(owner, chatId, botUuid, 201);

        MvcResult sent = botSend(token, botId, chatId, UUID.randomUUID(), "build #42 is green");
        assertThat(sent.getResponse().getStatus()).isEqualTo(201);
        JsonNode message = json(sent);
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("sender_type").asText()).isEqualTo("BOT");
        assertThat(message.get("bot_id").asText()).isEqualTo(botId);
        assertThat(message.get("sender_id").isNull()).isTrue();
        assertThat(message.get("sender_display_name").asText()).isEqualTo("Deploy Bot");
        assertThat(message.get("type").asText()).isEqualTo("TEXT");
        assertThat(message.get("text").asText()).isEqualTo("build #42 is green");
        String messageId = message.get("id").asText();

        // Stored as a BOT row with no user/device identity; the normal read path exposes it.
        Map<String, Object> row = migrator().queryForMap("""
                SELECT sender_type, bot_id, sender_id, sender_device_id, crypto_scheme
                  FROM message.messages WHERE id = ?
                """, UUID.fromString(messageId));
        assertThat(row.get("sender_type")).isEqualTo("BOT");
        assertThat(row.get("bot_id")).isEqualTo(botUuid);
        assertThat(row.get("sender_id")).isNull();
        assertThat(row.get("sender_device_id")).isNull();
        assertThat(row.get("crypto_scheme")).isEqualTo("MANAGED");

        MvcResult history = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), owner))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("MessagePage", json(history));
        JsonNode item = json(history).get("items").get(0);
        assertThat(item.get("sender_type").asText()).isEqualTo("BOT");
        assertThat(item.get("bot_id").asText()).isEqualTo(botId);

        // Idempotent replay: same key + same body -> same message, no second row.
        String key = UUID.randomUUID().toString();
        MvcResult first = botSendWithKey(token, botId, chatId, key, "once");
        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        String firstId = json(first).get("id").asText();
        MvcResult replay = botSendWithKey(token, botId, chatId, key, "once");
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(replay).get("id").asText()).isEqualTo(firstId);
        // The initial message and the first "once" send exist; replay/conflict add nothing.
        assertThat(messageCount(chatId)).isEqualTo(2);

        // Same key with another body is a conflict, not a silent second send.
        assertError(botSendWithKey(token, botId, chatId, key, "different"), 409,
                "IDEMPOTENCY_KEY_REUSED");
    }

    @Test
    void botTokenCannotReadMessagesFilesOrUseUserEndpoints() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        JsonNode created = createBot(owner, workspaceId, "Readless Bot");
        String botId = created.get("bot").get("id").asText();
        String token = created.get("token").asText();
        install(owner, chatId, UUID.fromString(botId), 201);

        // Bot has only chat.write: no history read.
        assertError(mockMvc.perform(get("/api/v1/chats/{chatId}/messages", chatId)
                .header("Authorization", "Bearer " + token)), 401, "UNAUTHENTICATED");
        // No user-send, file or workspace-management surface.
        assertError(mockMvc.perform(post("/api/v1/chats/{chatId}/messages", chatId)
                        .header("Authorization", "Bearer " + token)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "x", null))),
                401, "UNAUTHENTICATED");
        assertError(mockMvc.perform(get("/api/v1/files")
                .header("Authorization", "Bearer " + token)), 401, "UNAUTHENTICATED");
        assertError(mockMvc.perform(get("/api/v1/workspaces/{workspaceId}/bots", workspaceId)
                .header("Authorization", "Bearer " + token)), 401, "UNAUTHENTICATED");

        // A token cannot be used for another bot id, and a malformed token is a generic 401.
        assertError(botSend(token, UUID.randomUUID().toString(), chatId, UUID.randomUUID(),
                "wrong id"), 401, "UNAUTHENTICATED");
        assertError(botSend("sova_bot_not-a-token", botId, chatId, UUID.randomUUID(), "bad"),
                401, "UNAUTHENTICATED");

        // A delivered token may be revoked by uninstalling the bot from the chat.
        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/bots/{botId}", chatId,
                        UUID.fromString(botId)), owner))
                .andExpect(status().isNoContent());
        assertError(botSend(token, botId, chatId, UUID.randomUUID(), "uninstalled"), 403,
                "BOT_NOT_INSTALLED");
    }

    @Test
    void disablingRevokesTheTokenAndReEnablingRestoresIt() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        JsonNode created = createBot(owner, workspaceId, "Toggle Bot");
        String botId = created.get("bot").get("id").asText();
        String token = created.get("token").asText();
        UUID botUuid = UUID.fromString(botId);
        install(owner, chatId, botUuid, 201);
        assertThat(botSend(token, botId, chatId, UUID.randomUUID(), "alive").getResponse()
                .getStatus()).isEqualTo(201);

        mockMvc.perform(authed(delete("/api/v1/workspaces/{workspaceId}/bots/{botId}",
                        workspaceId, botUuid), owner))
                .andExpect(status().isNoContent());
        assertError(botSend(token, botId, chatId, UUID.randomUUID(), "disabled"), 401,
                "UNAUTHENTICATED");

        MvcResult patch = mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/bots/{botId}", workspaceId, botUuid),
                        owner).contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("status", "ACTIVE"))))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("Bot", json(patch));
        assertThat(json(patch).get("status").asText()).isEqualTo("ACTIVE");
        assertThat(botSend(token, botId, chatId, UUID.randomUUID(), "back").getResponse()
                .getStatus()).isEqualTo(201);
    }

    @Test
    void botCannotSendToAnE2eeChat() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("bots-owner"));
        UUID workspaceId = owner.workspace().id();
        JsonNode created = createBot(owner, workspaceId, "E2EE Bot");
        String botId = created.get("bot").get("id").asText();
        String token = created.get("token").asText();
        UUID botUuid = UUID.fromString(botId);
        UUID e2eeChatId = createE2eeChat(workspaceId, owner.user().id());
        // Install is impossible through the API; the direct row models a legacy/manual install
        // and must still be refused at send time.
        migrator().update("""
                INSERT INTO bot.chat_bots (workspace_id, chat_id, bot_id, enabled, installed_by)
                VALUES (?, ?, ?, true, ?)
                """, workspaceId, e2eeChatId, botUuid, owner.user().id());

        assertError(botSend(token, botId, e2eeChatId, UUID.randomUUID(), "nope"), 422,
                "BOT_E2EE_UNSUPPORTED");
        assertThat(messageCount(e2eeChatId)).isZero();
    }

    @Test
    void botTablesAreRlsProtectedAndCrossTenantInstallsAreRejected() throws Exception {
        SessionResponse a = devSession(uniqueDisplayName("bots-rls-a"));
        SessionResponse b = devSession(uniqueDisplayName("bots-rls-b"));
        JsonNode created = createBot(a, a.workspace().id(), "RLS Bot");
        UUID botId = UUID.fromString(created.get("bot").get("id").asText());
        install(a, a.chat().id(), botId, 201);

        int visible = inTenant(a.user().id(), a.workspace().id(), () -> jdbc.queryForObject(
                "SELECT count(*) FROM bot.bots", Integer.class));
        assertThat(visible).isEqualTo(1);
        int visibleChatBots = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject("SELECT count(*) FROM bot.chat_bots", Integer.class));
        assertThat(visibleChatBots).isEqualTo(1);
        int foreign = inTenant(a.user().id(), a.workspace().id(), () -> jdbc.queryForObject(
                "SELECT count(*) FROM bot.bots WHERE workspace_id = ?", Integer.class,
                b.workspace().id()));
        assertThat(foreign).isZero();
        // Without a tenant GUC the RLS policy hides everything.
        assertThat(jdbc.queryForObject("SELECT count(*) FROM bot.bots", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM bot.chat_bots", Integer.class))
                .isZero();

        // A direct cross-workspace install violates RLS/trigger even for the app role.
        assertThatThrownBy(() -> inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO bot.chat_bots
                               (workspace_id, chat_id, bot_id, enabled, installed_by)
                        VALUES (?, ?, ?, true, ?)
                        """, a.workspace().id(), b.chat().id(), botId, a.user().id())))
                .isInstanceOf(DataAccessException.class);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private JsonNode createBot(SessionResponse session, UUID workspaceId, String name)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/bots", workspaceId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(botBody(name, List.of("chat.write"))))
                .andExpect(status().isCreated())
                .andReturn();
        return json(result);
    }

    private MvcResult install(SessionResponse session, UUID chatId, UUID botId, int expected)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", chatId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("bot_id", botId))))
                .andExpect(status().is(expected))
                .andReturn();
    }

    private MvcResult botSend(String token, String botId, UUID chatId, UUID key, String text)
            throws Exception {
        return botSendWithKey(token, botId, chatId, key.toString(), text);
    }

    private MvcResult botSendWithKey(String token, String botId, UUID chatId, String key,
                                     String text) throws Exception {
        return mockMvc.perform(post("/api/v1/bots/{botId}/messages", botId)
                        .header("Authorization", "Bearer " + token)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "chat_id", chatId, "text", text))))
                .andReturn();
    }

    private String botBody(String name, List<String> scopes) throws Exception {
        return objectMapper.writeValueAsString(Map.of("name", name, "scopes", scopes));
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

    private UUID createE2eeChat(UUID workspaceId, UUID ownerId) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'E2EE', 'e2ee-bot-test', ?)
                """, chatId, workspaceId, ownerId);
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, chatId, workspaceId, ownerId);
        return chatId;
    }

    private void joinWorkspace(UUID workspaceId, UUID userId, String role) {        migrator().update("""
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

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), new SessionResponse.WorkspaceInfo(workspaceId, "ws", "MANAGED"),
                user.chat());
    }
}
