package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #94 Music Room backend slice: built-in plugin seed, idempotent per-workspace channel,
 * ACTIVE-member permissions, installation limits, AUDIO listing through the file center and
 * the plugin-disabled/kill-switch gates. No SFU or server-side playback is involved.
 */
@ActiveProfiles("test")
class MusicRoomIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PLUGIN_ID = "music-room";
    private static final String CHANNEL_NAME = "Музыкальная комната";

    @Autowired
    private TokenIssuer tokenIssuer;

    @AfterEach
    void restoreChatLimits() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = 100, max_chats_per_workspace = 1000
                 WHERE id = 1
                """);
        migrator().update("""
                UPDATE plugin.catalog SET state = 'ACTIVE' WHERE id = ?
                """, PLUGIN_ID);
    }

    @Test
    void opensTheRoomIdempotentlyWithOwnerAllMembersAndPluginEnabled() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("music-open-owner"));
        SessionResponse member = devSession(uniqueDisplayName("music-open-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id())).andExpect(status().isCreated());

        MvcResult first = open(owner, workspaceId).andExpect(status().isCreated()).andReturn();
        JsonNode body = json(first);
        CONTRACT.assertValid("MusicRoomOpen", body);

        UUID chatId = UUID.fromString(body.at("/chat/id").asText());
        assertThat(body.at("/created").asBoolean()).isTrue();
        assertThat(body.at("/chat/type").asText()).isEqualTo("GROUP");
        assertThat(body.at("/chat/security_mode").asText()).isEqualTo("MANAGED");
        assertThat(body.at("/chat/visibility").asText()).isEqualTo("PUBLIC");
        assertThat(body.at("/chat/join_policy").asText()).isEqualTo("OPEN");
        assertThat(body.at("/chat/name").asText()).isEqualTo(CHANNEL_NAME);
        assertThat(body.at("/plugin/plugin_id").asText()).isEqualTo(PLUGIN_ID);
        assertThat(body.at("/plugin/enabled").asBoolean()).isTrue();
        assertThat(body.at("/plugin/available").asBoolean()).isTrue();
        assertThat(body.at("/plugin/version").asText()).isEqualTo("1.0.0");
        assertThat(body.at("/plugin/reason").isMissingNode()
                || body.at("/plugin/reason").isNull()).isTrue();

        Map<String, Object> tag = migrator().queryForMap("""
                SELECT workspace_id, plugin_id, chat_id, created_by
                  FROM chat.plugin_rooms
                 WHERE workspace_id = ?
                """, workspaceId);
        assertThat(tag.get("workspace_id")).isEqualTo(workspaceId);
        assertThat(tag.get("plugin_id")).isEqualTo(PLUGIN_ID);
        assertThat(tag.get("chat_id")).isEqualTo(chatId);
        assertThat(tag.get("created_by")).isEqualTo(owner.user().id());
        assertThat(tagCount(workspaceId)).isEqualTo(1);

        assertThat(memberRow(chatId, owner.user().id()).get("role")).isEqualTo("OWNER");
        assertThat(memberRow(chatId, member.user().id()).get("status")).isEqualTo("ACTIVE");
        assertThat(memberRow(chatId, member.user().id()).get("role")).isEqualTo("MEMBER");
        assertThat(visibilityRow(chatId)).isEqualTo("PUBLIC");
        assertThat(pluginEnabled(chatId)).isTrue();
        assertThat(chatType(chatId)).isEqualTo("GROUP");

        // The channel creation is audited like any PUBLIC GROUP channel, with minimal
        // metadata (visibility + member_count only).
        Map<String, Object> createdAudit = migrator().queryForMap("""
                SELECT actor_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.created' AND target_id = ?
                """, chatId);
        assertThat(createdAudit.get("actor_id")).isEqualTo(owner.user().id());
        JsonNode createdMeta = objectMapper.readTree(
                String.valueOf(createdAudit.get("metadata")));
        assertThat(createdMeta.get("visibility").asText()).isEqualTo("PUBLIC");
        assertThat(createdMeta.get("member_count").asInt()).isEqualTo(2);
        assertThat(createdMeta.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("visibility", "member_count");

        // Second open: 200, same chat, no duplicate tag, no new chat.created audit.
        MvcResult second = open(owner, workspaceId).andExpect(status().isOk()).andReturn();
        JsonNode replay = json(second);
        CONTRACT.assertValid("MusicRoomOpen", replay);
        assertThat(replay.at("/created").asBoolean()).isFalse();
        assertThat(replay.at("/chat/id").asText()).isEqualTo(chatId.toString());
        assertThat(tagCount(workspaceId)).isEqualTo(1);
        assertThat(auditCount("chat.created", chatId)).isEqualTo(1);

        // Any ACTIVE workspace member reuses the same room; all members are already in it.
        SessionResponse memberScoped = scoped(member, workspaceId);
        MvcResult fromMember = open(memberScoped, workspaceId).andExpect(status().isOk())
                .andReturn();
        assertThat(json(fromMember).at("/chat/id").asText()).isEqualTo(chatId.toString());
        CONTRACT.assertValid("MusicRoomTracks", listOk(memberScoped, chatId));

        // Open audit is metadata-only: the boolean `created`, never names or user ids.
        var events = migrator().queryForList("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'music.room.opened' AND target_id = ?
                 ORDER BY seq
                """, chatId);
        assertThat(events).hasSize(3);
        for (Map<String, Object> event : events) {
            assertThat(event.get("target_type")).isEqualTo("chat");
            JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
            assertThat(metadata.fieldNames()).toIterable().containsExactly("created");
            assertThat(String.valueOf(event.get("metadata")))
                    .doesNotContain(owner.user().id().toString())
                    .doesNotContain(member.user().id().toString());
        }
        assertThat(events.get(0).get("actor_id")).isEqualTo(owner.user().id());
        assertThat(events.get(2).get("actor_id")).isEqualTo(member.user().id());
    }

    @Test
    void onlyActiveWorkspaceMembersCanOpenOrReadTheRoom() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("music-auth-owner"));
        SessionResponse member = devSession(uniqueDisplayName("music-auth-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("music-auth-outsider"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id())).andExpect(status().isCreated());
        UUID chatId = openOk(owner, workspaceId).at("/chat/id").asText().transform(UUID::fromString);

        // A non-member of the workspace cannot open or read the room.
        MvcResult denied = open(outsider, workspaceId).andExpect(status().isForbidden())
                .andReturn();
        CONTRACT.assertValid("Error", json(denied));
        assertThat(json(denied).get("code").asText()).isEqualTo("FORBIDDEN");
        MvcResult hidden = list(outsider, chatId).andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(hidden));
        assertThat(json(hidden).get("code").asText()).isEqualTo("NOT_FOUND");

        SessionResponse memberScoped = scoped(member, workspaceId);
        assertThat(json(open(memberScoped, workspaceId).andExpect(status().isOk()).andReturn())
                .at("/chat/id").asText()).isEqualTo(chatId.toString());
        assertThat(listOk(memberScoped, chatId).get("items")).isEmpty();

        // Removing the chat membership hides the room (404) but does not create a duplicate.
        migrator().update("""
                UPDATE chat.chat_members SET status = 'REMOVED'
                 WHERE chat_id = ? AND user_id = ?
                """, chatId, member.user().id());
        assertThat(list(memberScoped, chatId).andExpect(status().isNotFound()).andReturn()
                .getResponse().getStatus()).isEqualTo(404);
        open(memberScoped, workspaceId).andExpect(status().isNotFound());
        assertThat(tagCount(workspaceId)).isEqualTo(1);

        // A removed workspace membership is a 403 (the workspace gate runs first).
        migrator().update("""
                UPDATE workspace.memberships SET status = 'REMOVED'
                 WHERE workspace_id = ? AND user_id = ?
                """, workspaceId, member.user().id());
        open(memberScoped, workspaceId).andExpect(status().isForbidden());
    }

    @Test
    void respectsInstallationChatLimitsOnlyWhenCreatingTheRoom() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("music-limit-owner"));
        UUID workspaceId = owner.workspace().id();

        // The dev workspace already has one chat, so a user limit of 1 is exhausted.
        setChatLimits(1, 1000);
        MvcResult userLimited = open(owner, workspaceId).andExpect(status().isConflict())
                .andReturn();
        JsonNode userError = json(userLimited);
        CONTRACT.assertValid("Error", userError);
        assertThat(userError.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(userError.at("/details/scope").asText()).isEqualTo("USER");
        assertThat(tagCount(workspaceId)).isZero();

        setChatLimits(100, 1);
        MvcResult workspaceLimited = open(owner, workspaceId).andExpect(status().isConflict())
                .andReturn();
        JsonNode workspaceError = json(workspaceLimited);
        assertThat(workspaceError.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(workspaceError.at("/details/scope").asText()).isEqualTo("WORKSPACE");
        assertThat(tagCount(workspaceId)).isZero();

        setChatLimits(100, 1000);
        JsonNode created = openOk(owner, workspaceId);
        UUID chatId = UUID.fromString(created.at("/chat/id").asText());
        assertThat(created.at("/created").asBoolean()).isTrue();
        assertThat(tagCount(workspaceId)).isEqualTo(1);

        // Re-opening an existing room never consumes a slot, even at an exhausted limit.
        setChatLimits(1, 1);
        JsonNode replay = json(open(owner, workspaceId).andExpect(status().isOk()).andReturn());
        assertThat(replay.at("/created").asBoolean()).isFalse();
        assertThat(replay.at("/chat/id").asText()).isEqualTo(chatId.toString());
        assertThat(tagCount(workspaceId)).isEqualTo(1);
    }

    @Test
    void listsOnlyCleanAudioAttachmentsWithMetadataAndNoSensitiveFields() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("music-audio-owner"));
        SessionResponse member = devSession(uniqueDisplayName("music-audio-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id())).andExpect(status().isCreated());
        UUID chatId = UUID.fromString(openOk(owner, workspaceId).at("/chat/id").asText());

        Map<String, Object> alphaMedia = media("Alpha", "Artist A", 180_000,
                "https://cdn.example.com/alpha.jpg");
        Map<String, Object> betaMedia = media("Beta", "Artist B", 240_000,
                "https://cdn.example.com/beta.jpg");
        UUID alpha = uploadWithMedia(owner, chatId, "alpha.mp3", randomBytes(700),
                "audio/mpeg", alphaMedia);
        UUID beta = uploadWithMedia(owner, chatId, "beta.mp3", randomBytes(900),
                "audio/mpeg", betaMedia);
        UUID notAudio = UUID.fromString(uploadFile(owner, chatId, "playlist.pdf",
                randomBytes(300), "application/pdf").get("attachment_id").asText());
        MvcResult sent = sendWithAttachments(owner, chatId, "two tracks",
                List.of(alpha, beta, notAudio));
        assertThat(sent.getResponse().getStatus())
                .as(sent.getResponse().getContentAsString()).isEqualTo(201);

        JsonNode body = listOk(scoped(member, workspaceId), chatId);
        CONTRACT.assertValid("MusicRoomTracks", body);
        assertThat(body.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(body.at("/plugin/enabled").asBoolean()).isTrue();
        assertThat(body.at("/plugin/version").asText()).isEqualTo("1.0.0");
        assertThat(body.get("has_more").asBoolean()).isFalse();

        JsonNode items = body.get("items");
        assertThat(items).hasSize(2);
        assertThat(items.get(0).get("filename").asText()).isEqualTo("beta.mp3");
        assertThat(items.get(1).get("filename").asText()).isEqualTo("alpha.mp3");
        for (JsonNode item : items) {
            CONTRACT.assertValid("MusicRoomTrack", item);
            assertThat(item.get("mime_type").asText()).isEqualTo("audio/mpeg");
            assertThat(item.get("message_id").asText()).isNotBlank();
            assertThat(item.get("size_bytes").asLong()).isPositive();
            assertThat(item.get("created_at").asText()).isNotBlank();
            // No object key, hash, bytes or presigned URL can be read from this endpoint.
            assertThat(item.has("object_key")).isFalse();
            assertThat(item.has("sha256")).isFalse();
            assertThat(item.has("url")).isFalse();
            assertThat(item.has("content")).isFalse();
        }
        assertThat(items.get(0).get("title").asText()).isEqualTo("Beta");
        assertThat(items.get(0).get("artist").asText()).isEqualTo("Artist B");
        assertThat(items.get(0).get("duration_ms").asLong()).isEqualTo(240_000);
        assertThat(items.get(0).get("artwork_url").asText())
                .isEqualTo("https://cdn.example.com/beta.jpg");
        assertThat(body.toString()).doesNotContain(alpha + "/download")
                .doesNotContain(beta + "/download");
    }

    @Test
    void disabledPluginAndCatalogKillSwitchBlockTheRoom() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("music-disabled-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = UUID.fromString(openOk(owner, workspaceId).at("/chat/id").asText());

        patchPlugin(owner, chatId, false).andExpect(status().isOk());
        MvcResult disabled = list(owner, chatId).andExpect(status().isUnprocessableEntity())
                .andReturn();
        JsonNode disabledBody = json(disabled);
        CONTRACT.assertValid("Error", disabledBody);
        assertThat(disabledBody.get("code").asText()).isEqualTo("PLUGIN_NOT_ENABLED");
        assertThat(disabledBody.at("/details/plugin_id").asText()).isEqualTo(PLUGIN_ID);

        // Opening the room is the explicit enable action: it flips the toggle back on.
        JsonNode reopened = json(open(owner, workspaceId).andExpect(status().isOk()).andReturn());
        assertThat(reopened.at("/plugin/enabled").asBoolean()).isTrue();
        assertThat(pluginEnabled(chatId)).isTrue();
        assertThat(listOk(owner, chatId).get("items")).isEmpty();

        migrator().update("UPDATE plugin.catalog SET state = 'DISABLED' WHERE id = ?", PLUGIN_ID);
        try {
            MvcResult killed = list(owner, chatId).andExpect(status().isUnprocessableEntity())
                    .andReturn();
            JsonNode killedBody = json(killed);
            CONTRACT.assertValid("Error", killedBody);
            assertThat(killedBody.get("code").asText()).isEqualTo("PLUGIN_DISABLED");

            MvcResult openKilled = open(owner, workspaceId)
                    .andExpect(status().isUnprocessableEntity()).andReturn();
            assertThat(json(openKilled).get("code").asText()).isEqualTo("PLUGIN_DISABLED");
        } finally {
            migrator().update("UPDATE plugin.catalog SET state = 'ACTIVE' WHERE id = ?",
                    PLUGIN_ID);
        }
    }

    @Test
    void concurrentOpensCreateExactlyOneChannel() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("music-race-owner"));
        UUID workspaceId = owner.workspace().id();
        setChatLimits(100, 1000);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Callable<OpenResult>> calls = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                calls.add(() -> {
                    start.await();
                    MvcResult result = mockMvc.perform(authed(
                            post("/api/v1/workspaces/{workspaceId}/music-room", workspaceId),
                            owner)).andReturn();
                    JsonNode body = json(result);
                    return new OpenResult(result.getResponse().getStatus(),
                            body.at("/chat/id").asText(),
                            body.at("/created").asBoolean());
                });
            }
            List<Future<OpenResult>> futures = new ArrayList<>();
            for (Callable<OpenResult> call : calls) {
                futures.add(pool.submit(call));
            }
            start.countDown();
            List<OpenResult> results = new ArrayList<>();
            for (Future<OpenResult> future : futures) {
                results.add(future.get());
            }

            assertThat(results).extracting(OpenResult::status)
                    .containsExactlyInAnyOrder(200, 201);
            assertThat(results).extracting(OpenResult::chatId).containsOnly(
                    results.get(0).chatId());
            assertThat(results).filteredOn(OpenResult::created).hasSize(1);
            assertThat(tagCount(workspaceId)).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void schemaSeedsPluginAndProtectsTheRoomTagWithRls() throws Exception {
        Map<String, Object> plugin = migrator().queryForMap("""
                SELECT name, description, icon, permissions, modes, state, kind, version
                  FROM plugin.catalog WHERE id = ?
                """, PLUGIN_ID);
        assertThat(plugin.get("name")).isEqualTo(CHANNEL_NAME);
        assertThat(plugin.get("icon")).isEqualTo("music");
        assertThat(String.valueOf(plugin.get("permissions")))
                .isEqualTo("{FILES,MESSAGES}");
        assertThat(String.valueOf(plugin.get("modes"))).isEqualTo("{MANAGED}");
        assertThat(plugin.get("state")).isEqualTo("ACTIVE");
        assertThat(plugin.get("kind")).isEqualTo("BUILTIN");
        // Built-in catalog rows deliberately carry no external package version.
        assertThat(plugin.get("version")).isNull();

        Map<String, Object> flags = migrator().queryForMap("""
                SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                 WHERE oid = 'chat.plugin_rooms'::regclass
                """);
        assertThat(flags.get("relrowsecurity")).isEqualTo(true);
        assertThat(flags.get("relforcerowsecurity")).isEqualTo(true);
        for (String privilege : new String[]{"SELECT", "INSERT", "UPDATE", "DELETE"}) {
            assertThat(migrator().queryForObject(
                    "SELECT has_table_privilege('krug_app', 'chat.plugin_rooms', ?)",
                    Boolean.class, privilege)).as(privilege).isTrue();
        }
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'chat.plugin_rooms'::regclass AND contype = 'f'
                """, Long.class)).isEqualTo(2L);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'chat.plugin_rooms'::regclass
                   AND conname = 'uq_plugin_rooms_chat'
                """, Long.class)).isEqualTo(1L);

        SessionResponse owner = devSession(uniqueDisplayName("music-rls-owner"));
        SessionResponse stranger = devSession(uniqueDisplayName("music-rls-stranger"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO chat.plugin_rooms
                       (workspace_id, plugin_id, chat_id, created_by)
                VALUES (?, ?, ?, ?)
                """, workspaceId, PLUGIN_ID, chatId, owner.user().id()));

        Long visible = inTenant(stranger.user().id(), stranger.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM chat.plugin_rooms WHERE chat_id = ?",
                        Long.class, chatId));
        assertThat(visible).isZero();

        // PK backstop: the same workspace/plugin cannot be tagged twice.
        assertThatThrownBy(() -> inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO chat.plugin_rooms
                       (workspace_id, plugin_id, chat_id, created_by)
                VALUES (?, ?, ?, ?)
                """, workspaceId, PLUGIN_ID, owner.chat().id(), owner.user().id())))
                .isInstanceOf(DataAccessException.class);

        // WITH CHECK: a row cannot be written for another tenant under this GUC.
        assertThatThrownBy(() -> inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO chat.plugin_rooms
                       (workspace_id, plugin_id, chat_id, created_by)
                VALUES (?, ?, ?, ?)
                """, stranger.workspace().id(), PLUGIN_ID, owner.chat().id(),
                owner.user().id()))).isInstanceOf(DataAccessException.class);
    }

    // ------------------------------------------------------------------

    private ResultActions open(SessionResponse actor, UUID workspaceId) throws Exception {
        return mockMvc.perform(authed(
                post("/api/v1/workspaces/{workspaceId}/music-room", workspaceId), actor));
    }

    private JsonNode openOk(SessionResponse actor, UUID workspaceId) throws Exception {
        return json(open(actor, workspaceId).andExpect(status().isCreated()).andReturn());
    }

    private ResultActions list(SessionResponse actor, UUID chatId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/chats/{chatId}/music-room", chatId), actor));
    }

    private JsonNode listOk(SessionResponse actor, UUID chatId) throws Exception {
        return json(list(actor, chatId).andExpect(status().isOk()).andReturn());
    }

    private ResultActions patchPlugin(SessionResponse actor, UUID chatId, boolean enabled)
            throws Exception {
        return mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId, PLUGIN_ID),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("enabled", enabled))));
    }

    private ResultActions addMember(SessionResponse owner, UUID workspaceId, String email)
            throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/members", workspaceId), owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "email", email, "role", "MEMBER"))));
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private UUID uploadWithMedia(SessionResponse session, UUID chatId, String filename,
                                 byte[] data, String mime, Map<String, Object> media)
            throws Exception {
        MvcResult init = init(session, chatId, filename, data, mime, media);
        assertThat(init.getResponse().getStatus())
                .as(init.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode node = json(init);
        UUID uploadId = UUID.fromString(node.get("upload_id").asText());
        int partSize = node.get("part_size").asInt();
        int totalParts = node.get("total_parts").asInt();
        for (int partNo = 1; partNo <= totalParts; partNo++) {
            int from = (partNo - 1) * partSize;
            int to = Math.min(data.length, from + partSize);
            MvcResult part = putPart(session, uploadId, partNo,
                    Arrays.copyOfRange(data, from, to));
            assertThat(part.getResponse().getStatus()).isEqualTo(200);
        }
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(),
                totalParts);
        assertThat(complete.getResponse().getStatus())
                .as(complete.getResponse().getContentAsString()).isEqualTo(202);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());
        awaitScan(session, attachmentId, 200);
        return attachmentId;
    }

    private static Map<String, Object> media(String title, String artist, long durationMs,
                                             String artworkUrl) {
        Map<String, Object> media = new LinkedHashMap<>();
        media.put("kind", "AUDIO");
        media.put("metadata_source", "ID3");
        media.put("duration_ms", durationMs);
        media.put("title", title);
        media.put("artist", artist);
        media.put("artwork_url", artworkUrl);
        return media;
    }

    private void setChatLimits(int perUser, int perWorkspace) {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = ?, max_chats_per_workspace = ?
                 WHERE id = 1
                """, perUser, perWorkspace);
    }

    private long tagCount(UUID workspaceId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM chat.plugin_rooms WHERE workspace_id = ?",
                Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private Map<String, Object> memberRow(UUID chatId, UUID userId) {
        List<Map<String, Object>> rows = migrator().queryForList("""
                SELECT role, status FROM chat.chat_members
                 WHERE chat_id = ? AND user_id = ?
                """, chatId, userId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private boolean pluginEnabled(UUID chatId) {
        Boolean enabled = migrator().queryForObject("""
                SELECT enabled FROM chat.chat_plugins
                 WHERE chat_id = ? AND plugin_id = ?
                """, Boolean.class, chatId, PLUGIN_ID);
        return Boolean.TRUE.equals(enabled);
    }

    private String visibilityRow(UUID chatId) {
        List<String> rows = migrator().queryForList("""
                SELECT visibility FROM chat.channel_settings WHERE chat_id = ?
                """, String.class, chatId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private String chatType(UUID chatId) {
        return migrator().queryForObject(
                "SELECT type FROM chat.chats WHERE id = ?", String.class, chatId);
    }

    private long auditCount(String action, UUID chatId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = ? AND target_id = ?
                """, Long.class, action, chatId);
        return count == null ? 0 : count;
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private record OpenResult(int status, String chatId, boolean created) {
    }
}
