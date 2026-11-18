package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E7-B1F P2-10: with the E2EE flag ON, onboarding must not create an E2EE GROUP default
 * chat, {@code E2EE + GROUP} is rejected by the shared domain rule, and an E2EE DIRECT
 * chat is only created when both participants have an ACTIVE e2ee-capable device
 * (§6.2.8 {@code E2EE_NO_ACTIVE_DEVICES}).
 */
@SpringBootTest(properties = "krug.e2ee.enabled=true")
@AutoConfigureMockMvc
@ActiveProfiles("test")
class E2eeFlagOnIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void e2eeWorkspaceHasNoDefaultGroupAndCreationRequiresCapableDevices() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        String name = "E2EE workspace " + UUID.randomUUID();

        MvcResult workspaceResult = mockMvc.perform(authed(post("/api/v1/workspaces"), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", name, "security_mode", "E2EE"))))
                .andExpect(status().isCreated())
                .andReturn();
        UUID workspaceId = UUID.fromString(json(workspaceResult).get("id").asText());

        // No default GROUP chat — the only chat the old onboarding created was an E2EE GROUP.
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chats WHERE workspace_id = ?
                """, Integer.class, workspaceId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chats
                 WHERE workspace_id = ? AND security_mode = 'E2EE' AND type = 'GROUP'
                """, Integer.class, workspaceId)).isZero();

        joinWorkspace(workspaceId, bob);

        // E2EE + GROUP is rejected by the centralized Chat rule.
        MvcResult group = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        workspaceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "GROUP",
                                "name", "e2ee group"))))
                .andExpect(status().isConflict())
                .andReturn();
        assertThat(json(group).get("code").asText()).isEqualTo("E2EE_GROUP_NOT_SUPPORTED");

        // No capable devices yet -> fail closed.
        JsonNode noDevices = json(mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/chats", workspaceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                                "peer_id", bob.user().id().toString()))))
                .andExpect(status().isConflict())
                .andReturn());
        assertThat(noDevices.get("code").asText()).isEqualTo("E2EE_NO_ACTIVE_DEVICES");

        registerKeyed(alice, "flag-alice");
        registerKeyed(bob, "flag-bob");

        MvcResult created = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        workspaceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                                "peer_id", bob.user().id().toString()))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode chat = json(created);
        CONTRACT.assertValid("Chat", chat);
        assertThat(chat.get("security_mode").asText()).isEqualTo("E2EE");
        assertThat(chat.get("peer_has_e2ee_capable_devices").asBoolean()).isTrue();

        // Repeat -> 200 with the same chat (DIRECT pair idempotency still holds).
        MvcResult repeated = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        workspaceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                                "peer_id", bob.user().id().toString()))))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(repeated).get("id").asText()).isEqualTo(chat.get("id").asText());

        // The E2EE DIRECT chat is visible to the peer in the workspace list.
        JsonNode list = json(mockMvc.perform(authed(get(
                        "/api/v1/workspaces/{id}/chats", workspaceId), alice))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("ChatList", list);
        assertThat(list.get("items").size()).isEqualTo(1);
        assertThat(list.get("items").get(0).get("security_mode").asText()).isEqualTo("E2EE");
    }

    // ---------------------------------------------------------------------

    private void registerKeyed(SessionResponse session, String name) throws Exception {
        mockMvc.perform(authed(post("/api/v1/devices"), session)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                DeviceKeyTestSupport.generate().registrationBody(name,
                                        "0.7.0"))))
                .andExpect(status().isCreated());
    }

    private void joinWorkspace(UUID workspaceId, SessionResponse member) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, workspaceId, member.user().id());
    }
}
