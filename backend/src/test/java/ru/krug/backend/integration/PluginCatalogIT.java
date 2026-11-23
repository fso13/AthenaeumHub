package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * D1.1 (#69) read side: built-in catalog, per-chat state defaults, membership hiding and
 * authentication. There is no marketplace or execution surface.
 */
@ActiveProfiles("test")
class PluginCatalogIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final List<String> PLUGIN_IDS =
            List.of("polls", "tasks", "translate", "telegram", "dlp");

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void listsBuiltInCatalogWithPermissionsModesAndState() throws Exception {
        SessionResponse session = devSession();

        MvcResult result = mockMvc.perform(authed(get("/api/v1/plugins"), session))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("PluginList", body);

        assertThat(body.get("items")).hasSize(PLUGIN_IDS.size());
        assertThat(ids(body)).containsExactlyElementsOf(PLUGIN_IDS);
        for (JsonNode item : body.get("items")) {
            CONTRACT.assertValid("Plugin", item);
            assertThat(item.get("name").asText()).isNotBlank();
            assertThat(item.get("description").asText()).isNotBlank();
            assertThat(item.get("icon").asText()).isNotBlank();
            assertThat(item.get("state").asText()).isEqualTo("ACTIVE");
            assertThat(item.get("modes")).hasSize(1);
            assertThat(item.get("modes").get(0).asText()).isEqualTo("MANAGED");
            assertThat(item.get("permissions").isArray()).isTrue();
            // No marketplace/build artifacts or secrets are exposed by the catalog.
            assertThat(item.has("manifest")).isFalse();
            assertThat(item.has("version")).isFalse();
            assertThat(item.has("signature")).isFalse();
            assertThat(item.has("url")).isFalse();
        }
        assertThat(permissions(body, "telegram"))
                .containsExactly("MESSAGES", "MEMBERS", "WEBHOOKS");
        assertThat(permissions(body, "dlp")).containsExactly("MESSAGES", "FILES");
    }

    @Test
    void chatStateDefaultsToDisabledAndAvailableForManagedChat() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/plugins", chatId), session))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("ChatPluginStateList", body);

        assertThat(body.get("items")).hasSize(PLUGIN_IDS.size());
        assertThat(pluginIds(body)).containsExactlyElementsOf(PLUGIN_IDS);
        for (JsonNode item : body.get("items")) {
            CONTRACT.assertValid("ChatPluginState", item);
            assertThat(item.get("enabled").asBoolean()).isFalse();
            assertThat(item.get("available").asBoolean()).isTrue();
            assertThat(item.path("reason").isMissingNode() || item.get("reason").isNull())
                    .as("reason is omitted for an available plugin").isTrue();
        }
        // A GET has no side effects: no toggle rows are created by reading.
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM chat.chat_plugins WHERE chat_id = ?",
                Long.class, chatId)).isZero();
    }

    @Test
    void chatStateRequiresActiveChatMembershipAndHidesForeignChats() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("plugins-owner"));
        SessionResponse stranger = devSession(uniqueDisplayName("plugins-stranger"));
        SessionResponse workspaceOnly = devSession(uniqueDisplayName("plugins-ws-only"));
        UUID chatId = owner.chat().id();

        MvcResult own = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/plugins", chatId), owner))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("ChatPluginStateList", json(own));

        // A member of the workspace who is not an ACTIVE chat member is a 404 as well.
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, owner.workspace().id(), workspaceOnly.user().id());
        SessionResponse workspaceOnlyScoped = scoped(workspaceOnly, owner.workspace().id());

        assertChatStateMissing(stranger, chatId);
        assertChatStateMissing(workspaceOnlyScoped, chatId);
        assertChatStateMissing(owner, UUID.randomUUID());

        // Soft-deleted chats disappear from the endpoint.
        UUID deletedChat = owner.chat().id();
        migrator().update("UPDATE chat.chats SET deleted_at = now() WHERE id = ?", deletedChat);
        assertChatStateMissing(owner, deletedChat);

        MvcResult unauthenticated = mockMvc.perform(
                        get("/api/v1/chats/{chatId}/plugins", chatId))
                .andExpect(status().isUnauthorized())
                .andReturn();
        CONTRACT.assertValid("Error", json(unauthenticated));
    }

    @Test
    void catalogRequiresAuthenticationButNoWorkspace() throws Exception {
        MvcResult unauthenticated = mockMvc.perform(get("/api/v1/plugins"))
                .andExpect(status().isUnauthorized())
                .andReturn();
        CONTRACT.assertValid("Error", json(unauthenticated));

        // Any authenticated user may read the global built-in catalog.
        SessionResponse session = devSession();
        mockMvc.perform(authed(get("/api/v1/plugins"), session))
                .andExpect(status().isOk());
    }

    // ------------------------------------------------------------------

    private void assertChatStateMissing(SessionResponse actor, UUID chatId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/plugins", chatId), actor))
                .andExpect(status().isNotFound())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("NOT_FOUND");
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private static List<String> pluginIds(JsonNode body) {
        List<String> ids = new ArrayList<>();
        body.get("items").forEach(item -> ids.add(item.get("plugin_id").asText()));
        return ids;
    }

    private static List<String> ids(JsonNode body) {
        List<String> ids = new ArrayList<>();
        body.get("items").forEach(item -> ids.add(item.get("id").asText()));
        return ids;
    }

    private static List<String> permissions(JsonNode body, String pluginId) {
        for (JsonNode item : body.get("items")) {
            if (pluginId.equals(item.get("id").asText())) {
                List<String> values = new ArrayList<>();
                item.get("permissions").forEach(value -> values.add(value.asText()));
                return values;
            }
        }
        throw new AssertionError("plugin not found: " + pluginId);
    }
}
