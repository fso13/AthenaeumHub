package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #83 mentions: active-member validation, persisted message.mentions, MENTION notification,
 * the per-user mention inbox and read markers, @all role restrictions and idempotency.
 */
@ActiveProfiles("test")
class MentionsIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void explicitMentionIsStoredNotifiedAndReadableByTheRecipient() throws Exception {
        SessionResponse owner = devSession();
        SessionResponse member = devSession();
        SessionResponse outsider = devSession();
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroupChat(owner, workspaceId, "Mentions");
        joinWorkspace(owner, workspaceId, member);
        joinWorkspace(owner, workspaceId, outsider);
        addChatMember(owner, chatId, member.user().id());
        SessionResponse memberScoped = scoped(member, workspaceId);

        MvcResult sent = send(owner, chatId, "ping @member please", List.of(member.user().id()),
                false);
        assertThat(sent.getResponse().getStatus())
                .as(sent.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(sent);
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("mentions")).hasSize(1);
        assertThat(message.get("mentions").get(0).asText())
                .isEqualTo(member.user().id().toString());
        assertThat(message.get("mention_all").asBoolean()).isFalse();

        // Persisted mention metadata survives the jsonb round-trip on a history read.
        JsonNode stored = messageById(messages(owner, chatId), message.get("id").asText());
        CONTRACT.assertValid("Message", stored);
        assertThat(stored.get("mentions")).hasSize(1);
        assertThat(stored.get("mentions").get(0).asText())
                .isEqualTo(member.user().id().toString());
        assertThat(stored.get("mention_all").asBoolean()).isFalse();

        // Durable inbox row (one per recipient, mention_all=false) ...
        Map<String, Object> mentionRow = migrator().queryForMap("""
                SELECT user_id, mention_all, read_at FROM message.mentions
                 WHERE message_id = ? AND workspace_id = ?
                """, UUID.fromString(message.get("id").asText()), workspaceId);
        assertThat(mentionRow.get("user_id")).isEqualTo(member.user().id());
        assertThat(mentionRow.get("mention_all")).isEqualTo(false);
        assertThat(mentionRow.get("read_at")).isNull();

        // ... and a MENTION notification with no body (privacy invariant).
        Map<String, Object> notification = migrator().queryForMap("""
                SELECT type, body, title FROM notification.notifications
                 WHERE user_id = ? AND chat_id = ? AND type = 'MENTION'
                """, member.user().id(), chatId);
        assertThat(notification.get("type")).isEqualTo("MENTION");
        assertThat(notification.get("body")).isNull();
        assertThat((String) notification.get("title")).contains("упомянули");

        JsonNode page = mentions(memberScoped, null);
        CONTRACT.assertValid("MentionPage", page);
        assertThat(page.get("unread_count").asLong()).isEqualTo(1);
        assertThat(page.get("items")).hasSize(1);
        JsonNode item = page.get("items").get(0);
        CONTRACT.assertValid("Mention", item);
        assertThat(item.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(item.get("chat_name").asText()).isEqualTo("Mentions");
        assertThat(item.get("message_id").asText())
                .isEqualTo(message.get("id").asText());
        assertThat(item.get("sender_id").asText()).isEqualTo(owner.user().id().toString());
        assertThat(item.get("mention_all").asBoolean()).isFalse();
        assertThat(item.get("read_at").isNull()).isTrue();

        // The sender is never a recipient of their own mention.
        assertThat(mentions(owner, null).get("items")).isEmpty();

        MvcResult marked = markRead(memberScoped, null, true);
        assertThat(marked.getResponse().getStatus()).isEqualTo(204);
        assertThat(mentions(memberScoped, "true").get("items")).isEmpty();
        assertThat(mentions(memberScoped, "true").get("unread_count").asLong()).isZero();
        assertThat(mentions(memberScoped, null).get("items").get(0).get("read_at").isNull())
                .isFalse();
        // Idempotent repeat.
        assertThat(markRead(memberScoped, null, true).getResponse().getStatus()).isEqualTo(204);
    }

    @Test
    void allIsRestrictedToOwnerAdminAndMaterialisedForActiveMembers() throws Exception {
        SessionResponse owner = devSession();
        SessionResponse member = devSession();
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroupChat(owner, workspaceId, "Announcements");
        joinWorkspace(owner, workspaceId, member);
        addChatMember(owner, chatId, member.user().id());
        SessionResponse memberScoped = scoped(member, workspaceId);

        MvcResult all = send(owner, chatId, "@all standup in 5", List.of(), true);
        assertThat(all.getResponse().getStatus())
                .as(all.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(all);
        assertThat(message.get("mention_all").asBoolean()).isTrue();
        assertThat(message.get("mentions")).isEmpty();
        JsonNode storedAll = messageById(messages(owner, chatId), message.get("id").asText());
        assertThat(storedAll.get("mention_all").asBoolean()).isTrue();

        JsonNode memberPage = mentions(memberScoped, null);
        assertThat(memberPage.get("items")).hasSize(1);
        assertThat(memberPage.get("items").get(0).get("mention_all").asBoolean()).isTrue();
        assertThat(mentions(owner, null).get("items")).isEmpty();

        // A plain MEMBER may not ping the whole chat.
        MvcResult denied = send(memberScoped, chatId, "@all from a member", List.of(), true);
        assertThat(denied.getResponse().getStatus()).isEqualTo(403);
        CONTRACT.assertValid("Error", json(denied));
        assertThat(json(denied).get("code").asText()).isEqualTo("MENTION_ALL_FORBIDDEN");

        // The explicit mention of a non-chat-member is rejected without disclosing why.
        MvcResult notMember = send(owner, chatId, "hi outsider",
                List.of(UUID.randomUUID()), false);
        assertThat(notMember.getResponse().getStatus()).isEqualTo(422);
        CONTRACT.assertValid("Error", json(notMember));
        assertThat(json(notMember).get("code").asText()).isEqualTo("MENTION_INVALID");

        MvcResult tooMany = send(owner, chatId, "too many",
                randomIds(51), false);
        assertThat(tooMany.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(tooMany).at("/details/field").asText()).isEqualTo("mentions");

        // Duplicates collapse to one stored mention.
        MvcResult duplicate = send(owner, chatId, "dup @member",
                List.of(member.user().id(), member.user().id()), false);
        assertThat(duplicate.getResponse().getStatus()).isEqualTo(201);
        assertThat(json(duplicate).get("mentions")).hasSize(1);
    }

    @Test
    void stickerAndMalformedMentionPayloadsAreRejected() throws Exception {
        SessionResponse owner = devSession();
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroupChat(owner, workspaceId, "Validation");

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", UUID.randomUUID().toString());
        body.put("type", "STICKER");
        body.put("sticker_id", UUID.randomUUID().toString());
        body.put("mentions", List.of(UUID.randomUUID().toString()));
        MvcResult sticker = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", chatId), owner)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
        assertThat(sticker.getResponse().getStatus()).isEqualTo(422);
        CONTRACT.assertValid("Error", json(sticker));
        assertThat(json(sticker).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        MvcResult emptyQuery = mockMvc.perform(authed(get("/api/v1/me/mentions"), owner)
                .param("workspace_id", workspaceId.toString())
                .param("limit", "0")).andReturn();
        assertThat(emptyQuery.getResponse().getStatus()).isEqualTo(400);
        CONTRACT.assertValid("Error", json(emptyQuery));

        MvcResult noBody = mockMvc.perform(authed(post("/api/v1/me/mentions/read"), owner)
                .header("Idempotency-Key", UUID.randomUUID().toString())).andReturn();
        assertThat(noBody.getResponse().getStatus()).isEqualTo(400);
        CONTRACT.assertValid("Error", json(noBody));
    }

    // ------------------------------------------------------------------

    private static JsonNode messageById(JsonNode page, String id) {
        for (JsonNode item : page.get("items")) {
            if (id.equals(item.get("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("message " + id + " is not in history");
    }

    private MvcResult send(SessionResponse session, UUID chatId, String text, List<UUID> mentions,
                           boolean mentionAll) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", UUID.randomUUID().toString());
        body.put("type", "TEXT");
        body.put("text", text);
        if (!mentions.isEmpty()) {
            body.put("mentions", mentions.stream().map(UUID::toString).toList());
        }
        if (mentionAll) {
            body.put("mention_all", true);
        }
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
    }

    private JsonNode mentions(SessionResponse session, String unread) throws Exception {
        var builder = get("/api/v1/me/mentions");
        if (unread != null) {
            builder.param("unread", unread);
        }
        MvcResult result = mockMvc.perform(authed(builder, session)).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
        return json(result);
    }

    private MvcResult markRead(SessionResponse session, List<UUID> ids, boolean all)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        if (ids != null && !ids.isEmpty()) {
            body.put("ids", ids.stream().map(UUID::toString).toList());
        }
        if (all) {
            body.put("all", true);
        }
        return mockMvc.perform(authed(post("/api/v1/me/mentions/read"), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
    }

    private static List<UUID> randomIds(int count) {
        List<UUID> ids = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            ids.add(UUID.randomUUID());
        }
        return ids;
    }

    private UUID createGroupChat(SessionResponse session, UUID workspaceId, String name)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("type", "GROUP", "name", name))))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(json(result).get("id").asText());
    }

    private void joinWorkspace(SessionResponse owner, UUID workspaceId, SessionResponse user)
            throws Exception {
        String email = migrator().queryForObject("SELECT email FROM auth.users WHERE id = ?",
                String.class, user.user().id());
        MvcResult result = mockMvc.perform(authed(post(
                "/api/v1/workspaces/{workspaceId}/members", workspaceId), owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("email", email,
                        "role", "MEMBER")))).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
    }

    private void addChatMember(SessionResponse owner, UUID chatId, UUID userId) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/chats/{chatId}/members", chatId),
                        owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("user_id", userId.toString(),
                        "role", "MEMBER")))).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isIn(200, 201);
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }
}
