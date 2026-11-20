package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #84: membership-scoped workspace overview. Verifies aggregate sums against the database,
 * the manager-only audit preview, empty-workspace values, foreign-workspace 403 and the
 * absence of content/filenames.
 */
@ActiveProfiles("test")
class WorkspaceOverviewIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void overviewSumsMembersChatsMessagesFilesDlpAndStorage() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("overview-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        SessionResponse member = devSession(uniqueDisplayName("overview-member"));
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER");

        String secret = "OVERVIEW-SECRET-" + UUID.randomUUID();
        sendMessage(owner, chatId, UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                secret);
        sendMessage(owner, chatId, UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                "second");
        insertAttachment(workspaceId, chatId, owner.user().id());
        insertDlpEvent(workspaceId, owner.user().id(), chatId);

        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"require_2fa\":true}"))
                .andExpect(status().isOk());

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/overview", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("WorkspaceOverview", body);

        assertThat(body.at("/members/total").asLong()).isEqualTo(activeMembers(workspaceId));
        assertThat(body.at("/members/online").asLong()).isZero()
                .isLessThanOrEqualTo(body.at("/members/total").asLong());
        assertThat(body.get("chats").asLong()).isEqualTo(activeChats(workspaceId));
        assertThat(body.at("/messages/total").asLong()).isEqualTo(allocatedMessages(workspaceId));
        assertThat(body.at("/messages/last_24h").asLong()).isEqualTo(messagesLast24h(workspaceId));
        assertThat(body.at("/files/total").asLong()).isEqualTo(1);
        assertThat(body.at("/files/used_bytes").asLong()).isEqualTo(4096);
        assertThat(body.at("/files/reserved_bytes").asLong()).isEqualTo(128);
        assertThat(body.at("/dlp/events_last_24h").asLong()).isEqualTo(1);
        assertThat(body.at("/storage/used_bytes").asLong()).isEqualTo(4096);
        assertThat(body.at("/storage/quota_bytes").asLong()).isEqualTo(1048576);
        assertThat(body.get("audit_recent").size()).isBetween(1, 5);
        assertThat(body.get("audit_recent").toString()).contains("workspace.security.updated");

        assertThat(result.getResponse().getContentAsString())
                .doesNotContain(secret, "report.pdf", "OVERVIEW-DLP");

        // The plain member sees the same aggregates but no audit preview.
        JsonNode memberView = json(mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/overview", workspaceId), member))
                .andExpect(status().isOk())
                .andReturn());
        CONTRACT.assertValid("WorkspaceOverview", memberView);
        assertThat(memberView.at("/messages/last_24h").asLong())
                .isEqualTo(body.at("/messages/last_24h").asLong());
        assertThat(memberView.get("audit_recent").size()).isZero();
    }

    @Test
    void emptyWorkspaceReturnsZeroCounts() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("overview-empty"));
        UUID workspaceId = owner.workspace().id();

        JsonNode body = json(mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/overview", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn());
        CONTRACT.assertValid("WorkspaceOverview", body);
        assertThat(body.at("/members/total").asLong()).isEqualTo(1);
        assertThat(body.at("/members/online").asLong()).isZero();
        assertThat(body.get("chats").asLong()).isEqualTo(1);
        assertThat(body.at("/messages/total").asLong()).isZero();
        assertThat(body.at("/messages/last_24h").asLong()).isZero();
        assertThat(body.at("/files/total").asLong()).isZero();
        assertThat(body.at("/files/used_bytes").asLong()).isZero();
        assertThat(body.at("/dlp/events_last_24h").asLong()).isZero();
        assertThat(body.at("/storage/quota_bytes").asLong()).isEqualTo(1099511627776L);
        assertThat(body.get("audit_recent").size()).isZero();
    }

    @Test
    void foreignAndUnknownWorkspacesAreForbiddenWithoutDisclosure() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("overview-private"));
        SessionResponse outsider = devSession(uniqueDisplayName("overview-outsider"));

        assertThat(mockMvc.perform(authed(get("/api/v1/workspaces/{id}/overview",
                        owner.workspace().id()), outsider))
                .andExpect(status().isForbidden())
                .andReturn().getResponse().getContentAsString()).contains("FORBIDDEN");

        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/overview", UUID.randomUUID()),
                        outsider))
                .andExpect(status().isForbidden());
    }

    @Test
    void overviewDoesNotExposePerUserContentFields() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("overview-shape"));
        JsonNode body = json(mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/overview", owner.workspace().id()), owner))
                .andExpect(status().isOk())
                .andReturn());
        for (String forbidden : new String[]{"text", "body", "content", "ciphertext",
                "filename", "email", "ip_address", "access_token", "refresh_token"}) {
            assertThat(body.has(forbidden)).as(forbidden).isFalse();
        }
        assertThat(body.at("/audit_recent").size()).isZero();
        assertThat(body.at("/generated_at").asText()).isNotBlank();
    }

    private void addMember(SessionResponse owner, UUID workspaceId, String email, String role)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("role", role);
        mockMvc.perform(authed(post("/api/v1/workspaces/{id}/members", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated());
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject("SELECT email::text FROM auth.users WHERE id = ?",
                String.class, userId);
    }

    private long activeMembers(UUID workspaceId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM workspace.memberships m
                  JOIN auth.users u ON u.id = m.user_id AND u.status = 'ACTIVE'
                 WHERE m.workspace_id = ? AND m.status = 'ACTIVE'
                """, Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private long activeChats(UUID workspaceId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM chat.chats
                 WHERE workspace_id = ? AND deleted_at IS NULL
                """, Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private long allocatedMessages(UUID workspaceId) {
        Long count = migrator().queryForObject("""
                SELECT COALESCE(sum(GREATEST(cc.next_seq - 1, 0)), 0)
                  FROM chat.chat_counters cc
                  JOIN chat.chats c ON c.id = cc.chat_id AND c.deleted_at IS NULL
                 WHERE cc.workspace_id = ?
                """, Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private long messagesLast24h(UUID workspaceId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM message.messages
                 WHERE workspace_id = ?
                   AND created_at >= now() - interval '24 hours'
                   AND deleted_at IS NULL
                """, Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private void insertAttachment(UUID workspaceId, UUID chatId, UUID userId) {
        UUID uploadId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO file.uploads
                       (id, workspace_id, chat_id, user_id, filename, mime_type, size_bytes,
                        status, part_size, total_parts, expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'report.pdf', 'application/pdf', 4096, 'READY',
                        5242880, 1, now() + interval '1 day', now(), now())
                """, uploadId, workspaceId, chatId, userId);
        migrator().update("""
                INSERT INTO file.attachments
                       (id, workspace_id, chat_id, upload_id, user_id, message_id, filename,
                        mime_type, size_bytes, sha256, object_key, status, scan_status,
                        created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, NULL, 'report.pdf', 'application/pdf', 4096,
                        repeat('a', 64), ?, 'READY', 'CLEAN', now(), now())
                """, UUID.randomUUID(), workspaceId, chatId, uploadId, userId,
                "overview/" + UUID.randomUUID());
        migrator().update("""
                INSERT INTO file.workspace_usage (workspace_id, used_bytes, reserved_bytes)
                VALUES (?, 4096, 128)
                ON CONFLICT (workspace_id) DO UPDATE
                   SET used_bytes = EXCLUDED.used_bytes,
                       reserved_bytes = EXCLUDED.reserved_bytes
                """, workspaceId);
        migrator().update("""
                INSERT INTO file.workspace_limits (workspace_id, storage_bytes)
                VALUES (?, 1048576)
                ON CONFLICT (workspace_id) DO UPDATE
                   SET storage_bytes = EXCLUDED.storage_bytes
                """, workspaceId);
    }

    private void insertDlpEvent(UUID workspaceId, UUID actorId, UUID chatId) {
        migrator().update("""
                INSERT INTO workspace.dlp_events
                       (id, workspace_id, policy_id, rule_name, action, actor_id, chat_id,
                        created_at)
                VALUES (?, ?, NULL, 'OVERVIEW-DLP', 'WARN', ?, ?, ?)
                """, UUID.randomUUID(), workspaceId, actorId, chatId,
                Timestamp.from(Instant.now()));
    }
}
