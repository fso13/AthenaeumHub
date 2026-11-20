package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #83: mention metadata is plaintext and therefore forbidden in an E2EE chat. The check runs
 * before any envelope/key work, so the request is rejected without touching the mention table
 * and without storing a message.
 */
@SpringBootTest(properties = "krug.e2ee.enabled=true")
@AutoConfigureMockMvc
@ActiveProfiles("test")
class MentionsE2eeIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void mentionsAreRejectedInAnE2eeChatBeforeAnythingIsStored() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        // An E2EE DIRECT chat, provisioned directly: the mode-change API is a separate
        // flow, and this test only needs an E2EE chat the caller participates in.
        UUID chatId = UUID.randomUUID();
        java.util.List<UUID> pair = new java.util.ArrayList<>(
                java.util.List.of(UUID.randomUUID(), UUID.randomUUID()));
        pair.sort(java.util.Comparator.comparing(UUID::toString));
        String directKey = pair.get(0) + ":" + pair.get(1);
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, created_by,
                                        direct_key)
                VALUES (?, ?, 'DIRECT', 'E2EE', ?, ?)
                """, chatId, workspaceId, session.user().id(), directKey);
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, chatId, workspaceId, session.user().id());

        // A syntactically valid envelope array: the mention guard must fire before any
        // device/key validation turns this into a different error.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", UUID.randomUUID().toString());
        body.put("type", "TEXT");
        body.put("envelopes", List.of(envelope(chatId, session.device().id())));
        body.put("mentions", List.of(session.user().id().toString()));
        body.put("mention_all", true);
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", chatId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();

        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("E2EE_PLAINTEXT_FORBIDDEN");
        assertThat(error.at("/details/field").asText()).isEqualTo("mentions");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM message.mentions WHERE chat_id = ?
                """, Integer.class, chatId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM message.messages WHERE chat_id = ?
                """, Integer.class, chatId)).isZero();
    }

    private static Map<String, Object> envelope(UUID chatId, UUID senderDeviceId) {
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("v", 1);
        header.put("dh", base64(32));
        header.put("pn", 0);
        header.put("n", 0);
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("v", 1);
        envelope.put("scheme", "PAIRWISE_X3DH_DR");
        envelope.put("chat_id", chatId.toString());
        envelope.put("sender_device_id", senderDeviceId.toString());
        envelope.put("sender_key_generation", 1);
        envelope.put("recipient_device_id", UUID.randomUUID().toString());
        envelope.put("recipient_key_generation", 1);
        envelope.put("session_id", base64(16));
        envelope.put("header", header);
        envelope.put("ciphertext", base64(272));
        return envelope;
    }

    private static String base64(int length) {
        byte[] bytes = new byte[length];
        new java.util.Random(7).nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
