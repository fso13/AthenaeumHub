package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #83 server-side message search: literal managed plaintext only, no cross-chat leak,
 * E2EE/deleted/hidden exclusion, chat/time filters, snippets with highlights and stable
 * cursor pagination.
 */
@ActiveProfiles("test")
class MessageSearchIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void returnsOnlyAccessibleManagedPlaintextWithSnippetAndHighlights() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = session.chat().id();
        UUID first = messageId(session, chatId, "The Alpha budget report is ready");
        UUID second = messageId(session, chatId, "alpha BUDGET plan");

        JsonNode page = search(session, workspaceId, "q", "alpha");
        CONTRACT.assertValid("MessageSearchPage", page);
        assertThat(page.get("items")).hasSize(2);
        assertThat(page.get("query").asText()).isEqualTo("alpha");
        assertThat(ids(page)).containsExactlyInAnyOrder(first.toString(), second.toString());

        JsonNode hit = page.get("items").get(0);
        CONTRACT.assertValid("MessageSearchHit", hit);
        assertThat(hit.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(hit.get("chat_name").asText()).isEqualTo(session.chat().name());
        assertThat(hit.get("sender_id").asText()).isEqualTo(session.user().id().toString());
        assertThat(hit.get("snippet").asText().toLowerCase()).contains("alpha");
        assertThat(hit.get("snippet").asText()).doesNotContain("<").doesNotContain(">");

        // Highlight ranges are consistent with the returned plain-text snippet.
        String snippet = hit.get("snippet").asText();
        JsonNode highlights = hit.get("highlights");
        assertThat(highlights).isNotEmpty();
        for (JsonNode highlight : highlights) {
            int start = highlight.get("start").asInt();
            int end = highlight.get("end").asInt();
            assertThat(start).isGreaterThanOrEqualTo(0);
            assertThat(end).isGreaterThan(start);
            assertThat(snippet.substring(start, end).toLowerCase()).isEqualTo("alpha");
        }

        // case-insensitive, literal only; regex/wildcard characters are plain characters
        assertThat(search(session, workspaceId, "q", "BUDGET").get("items")).hasSize(2);
        assertThat(search(session, workspaceId, "q", "alpha.*").get("items")).isEmpty();
        assertThat(search(session, workspaceId, "q", "%").get("items")).isEmpty();
    }

    @Test
    void filtersByChatAndNeverLeaksAChatTheCallerIsNotIn() throws Exception {
        SessionResponse owner = devSession();
        SessionResponse member = devSession();
        SessionResponse bystander = devSession();
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(owner, workspaceId, member);
        joinWorkspace(owner, workspaceId, bystander);
        SessionResponse memberScoped = scoped(member, workspaceId);

        // PUBLIC group: every ACTIVE workspace member joins automatically.
        UUID accessibleChatId = createGroupChat(owner, workspaceId, "Accessible");
        // PRIVATE channel: only the explicit member list; `member` is deliberately not in it.
        UUID privateChatId = createPrivateChannel(owner, workspaceId, "Search private",
                List.of(bystander.user().id()));

        messageId(owner, accessibleChatId, "alpha in accessible");
        messageId(owner, privateChatId, "alpha in the private group");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chat_members WHERE chat_id = ? AND user_id = ?
                """, Integer.class, privateChatId, member.user().id())).isZero();

        // The member is in the accessible chat but not in the private one: no leak.
        JsonNode memberPage = search(memberScoped, workspaceId, "q", "alpha");
        assertThat(memberPage.get("items")).hasSize(1);
        assertThat(memberPage.get("items").get(0).get("chat_id").asText())
                .isEqualTo(accessibleChatId.toString());
        assertThat(memberPage.toString()).doesNotContain("private group");

        // A chat filter for a chat the caller is not in is hidden (404).
        MvcResult forbiddenChat = searchRaw(memberScoped, workspaceId, "q", "alpha",
                "chat_id", privateChatId.toString());
        assertThat(forbiddenChat.getResponse().getStatus()).isEqualTo(404);
        assertThat(json(forbiddenChat).get("code").asText()).isEqualTo("NOT_FOUND");

        JsonNode groupPage = search(owner, workspaceId, "q", "alpha", "chat_id",
                privateChatId.toString());
        assertThat(groupPage.get("items")).hasSize(1);
        assertThat(groupPage.get("items").get(0).get("snippet").asText())
                .contains("private group");

        // A foreign workspace is 403 without disclosing anything.
        SessionResponse outsider = devSession();
        MvcResult foreign = searchRaw(outsider, workspaceId, "q", "alpha");
        assertThat(foreign.getResponse().getStatus()).isEqualTo(403);
        CONTRACT.assertValid("Error", json(foreign));

        // Time window: everything is older than a future exclusive bound, nothing is newer.
        Instant future = Instant.now().plusSeconds(3600);
        assertThat(search(owner, workspaceId, "q", "alpha", "to", future.toString())
                .get("items")).hasSize(2);
        assertThat(search(owner, workspaceId, "q", "alpha", "from", future.toString())
                .get("items")).isEmpty();
    }

    @Test
    void excludesDeletedHiddenAndE2eeMessages() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = session.chat().id();

        UUID visible = messageId(session, chatId, "alpha visible");
        UUID deletedForAll = messageId(session, chatId, "alpha deleted for all");
        UUID hiddenForMe = messageId(session, chatId, "alpha hidden for me");

        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/messages/{messageId}", chatId,
                deletedForAll), session)).andReturn();
        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/messages/{messageId}", chatId,
                hiddenForMe), session).param("scope", "me")).andReturn();

        // A raw E2EE-scheme row with opaque bytes: the SQL gate must exclude it even though
        // the ciphertext is not searchable.
        insertE2eeMessage(workspaceId, chatId, "alpha e2ee ciphertext");

        JsonNode page = search(session, workspaceId, "q", "alpha");
        assertThat(ids(page)).containsExactly(visible.toString());
    }

    @Test
    void paginatesWithAnOpaqueCursorBoundToTheSearch() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = session.chat().id();
        for (int i = 0; i < 3; i++) {
            messageId(session, chatId, "alpha page " + i);
        }

        List<String> found = new ArrayList<>();
        String cursor = null;
        boolean hasMore = true;
        int pages = 0;
        while (hasMore) {
            JsonNode page = cursor == null
                    ? search(session, workspaceId, "q", "alpha", "limit", "1")
                    : search(session, workspaceId, "q", "alpha", "limit", "1",
                            "cursor", cursor);
            page.get("items").forEach(item -> found.add(item.get("message_id").asText()));
            hasMore = page.at("/page/has_more").asBoolean();
            cursor = page.at("/page/next_cursor").isNull() ? null
                    : page.at("/page/next_cursor").asText();
            pages++;
            assertThat(pages).isLessThanOrEqualTo(4);
        }
        assertThat(pages).isEqualTo(3);
        assertThat(found).hasSize(3).doesNotHaveDuplicates();

        // A cursor is bound to its query and workspace.
        JsonNode firstPage = search(session, workspaceId, "q", "alpha", "limit", "1");
        String validCursor = firstPage.at("/page/next_cursor").asText();
        MvcResult otherQuery = searchRaw(session, workspaceId, "q", "budget", "limit", "1",
                "cursor", validCursor);
        assertThat(otherQuery.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(otherQuery).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        SessionResponse outsider = devSession();
        MvcResult foreignCursor = searchRaw(session, outsider.workspace().id(), "q", "alpha",
                "limit", "1", "cursor", validCursor);
        assertThat(foreignCursor.getResponse().getStatus()).isEqualTo(403);
    }

    @Test
    void validatesQueryParameters() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();

        assertThat(searchRaw(session, workspaceId).getResponse().getStatus()).isEqualTo(400);
        assertThat(searchRaw(session, workspaceId, "q", "").getResponse().getStatus())
                .isEqualTo(400);
        assertThat(searchRaw(session, workspaceId, "q", "x".repeat(201)).getResponse()
                .getStatus()).isEqualTo(400);
        assertThat(searchRaw(session, workspaceId, "q", "alpha", "limit", "0").getResponse()
                .getStatus()).isEqualTo(400);
        assertThat(searchRaw(session, workspaceId, "q", "alpha", "limit", "51").getResponse()
                .getStatus()).isEqualTo(400);
        MvcResult badInstant = searchRaw(session, workspaceId, "q", "alpha", "from", "yesterday");
        assertThat(badInstant.getResponse().getStatus()).isEqualTo(400);
        CONTRACT.assertValid("Error", json(badInstant));
        assertThat(json(badInstant).at("/details/field").asText()).isEqualTo("from");
    }

    // ------------------------------------------------------------------

    private MvcResult searchRaw(SessionResponse session, UUID workspaceId, String... params)
            throws Exception {
        MockHttpServletRequestBuilder builder = get(
                "/api/v1/workspaces/{workspaceId}/search/messages", workspaceId);
        for (int i = 0; i + 1 < params.length; i += 2) {
            builder.param(params[i], params[i + 1]);
        }
        return mockMvc.perform(authed(builder, session)).andReturn();
    }

    private JsonNode search(SessionResponse session, UUID workspaceId, String... params)
            throws Exception {
        MvcResult result = searchRaw(session, workspaceId, params);
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
        return json(result);
    }

    private UUID messageId(SessionResponse session, UUID chatId, String text) throws Exception {
        return UUID.fromString(sendMessage(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), text).get("id").asText());
    }

    private static List<String> ids(JsonNode page) {
        List<String> values = new ArrayList<>();
        page.get("items").forEach(item -> values.add(item.get("message_id").asText()));
        return values;
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

    private UUID createPrivateChannel(SessionResponse session, UUID workspaceId, String name,
                                      List<UUID> memberIds) throws Exception {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", name);
        body.put("visibility", "PRIVATE");
        body.put("member_ids", memberIds.stream().map(UUID::toString).toList());
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(json(result).get("id").asText());
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

    private void insertE2eeMessage(UUID workspaceId, UUID chatId, String ciphertext) {
        Object maxSeq = migrator().queryForObject("""
                SELECT COALESCE(MAX(seq), 0) FROM message.messages
                 WHERE workspace_id = ? AND chat_id = ?
                """, Long.class, workspaceId, chatId);
        long seq = ((Number) maxSeq).longValue() + 1;
        migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, sender_device_id,
                        sender_display_name, type, crypto_scheme, body_ciphertext, content_meta,
                        created_at, version)
                VALUES (?, ?, ?, ?, ?, ?, 'e2ee', 'TEXT', 'E2EE_PAIRWISE', NULL, '{}'::jsonb,
                        ?, 1)
                """, UUID.randomUUID(), workspaceId, chatId, seq, UUID.randomUUID(),
                UUID.randomUUID(), Timestamp.from(Instant.now()));
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }
}
