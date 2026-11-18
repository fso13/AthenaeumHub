package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakTestSupport;
import ru.krug.backend.support.OpenApiContract;

@SpringBootTest(properties = {
        // Test isolation: this profile does not load application-test.yml, so its
        // noop scanner would otherwise mark files of sibling test contexts CLEAN.
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=keycloak-test-content-key-please-change-32-bytes"
})
@ActiveProfiles("keycloak")
class KeycloakAuthIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void devSessionIsAbsentInKeycloakProfile() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/dev/session"))
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("NOT_FOUND");
        CONTRACT.assertValid("Error", json(result));
    }

    @Test
    void meWithoutTokenReturnsContractual401() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/me"))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(result, "UNAUTHENTICATED");
    }

    @Test
    void jitMeDeviceWorkspaceAndDefaultChatFlow() throws Exception {
        String subject = KeycloakTestSupport.uniqueSubject("kc-flow");
        String email = KeycloakTestSupport.uniqueEmail("flow");
        var auth = KeycloakTestSupport.keycloakJwt(subject, email, "flow-user", "Flow User");

        MvcResult emptyMe = mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode emptyMeJson = json(emptyMe);
        CONTRACT.assertValid("MeResponse", emptyMeJson);
        assertThat(emptyMeJson.get("user").get("email").asText()).isEqualTo(email);
        assertThat(emptyMeJson.get("workspaces")).isEmpty();
        assertThat(emptyMeJson.get("default_workspace_id").isNull()).isTrue();
        UUID userId = UUID.fromString(emptyMeJson.get("user").get("id").asText());

        // JIT provisioning is idempotent: a second request does not create another user.
        mockMvc.perform(get("/api/v1/me").with(auth)).andExpect(status().isOk());
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.user_identities WHERE provider = 'keycloak'"
                        + " AND subject = ?", Integer.class, subject)).isEqualTo(1);

        String deviceName = "Chrome " + UUID.randomUUID();
        MvcResult deviceResult = mockMvc.perform(post("/api/v1/devices")
                        .with(auth)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", deviceName,
                                "platform", "WEB",
                                "app_version", "1.0.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode device = json(deviceResult);
        CONTRACT.assertValid("Device", device);
        String deviceId = device.get("id").asText();

        MvcResult workspaceResult = mockMvc.perform(post("/api/v1/workspaces")
                        .with(auth)
                        .header("X-Device-Id", deviceId)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Команда " + UUID.randomUUID(),
                                "security_mode", "MANAGED"))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode workspace = json(workspaceResult);
        CONTRACT.assertValid("WorkspaceSummary", workspace);
        assertThat(workspace.get("role").asText()).isEqualTo("OWNER");
        String workspaceId = workspace.get("id").asText();

        MvcResult me = mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode meJson = json(me);
        CONTRACT.assertValid("MeResponse", meJson);
        assertThat(meJson.get("workspaces")).hasSize(1);
        assertThat(meJson.get("default_workspace_id").asText()).isEqualTo(workspaceId);

        MvcResult chats = mockMvc.perform(get("/api/v1/workspaces/{id}/chats", workspaceId)
                        .with(auth)
                        .header("X-Device-Id", deviceId))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode chatList = json(chats);
        CONTRACT.assertValid("ChatList", chatList);
        assertThat(chatList.get("items")).hasSize(1);
        assertThat(chatList.get("items").get(0).get("name").asText()).isEqualTo("Общий чат");
        assertThat(chatList.get("items").get(0).get("type").asText()).isEqualTo("GROUP");

        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM audit.audit_events WHERE action = 'user.provisioned'"
                        + " AND actor_id = ?", Integer.class, userId)).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM audit.audit_events WHERE action = 'workspace.created'"
                        + " AND workspace_id = ?", Integer.class,
                UUID.fromString(workspaceId))).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM chat.chat_members WHERE chat_id = ("
                        + "SELECT id FROM chat.chats WHERE workspace_id = ?)"
                        + " AND user_id = ? AND role = 'OWNER' AND status = 'ACTIVE'",
                Integer.class, UUID.fromString(workspaceId), userId)).isEqualTo(1);
    }

    @Test
    void deviceRegistrationIsIdempotentAndLimitedToFive() throws Exception {
        String subject = KeycloakTestSupport.uniqueSubject("kc-device");
        var auth = KeycloakTestSupport.keycloakJwt(subject,
                KeycloakTestSupport.uniqueEmail("device"), "device-user", "Device User");
        String key = UUID.randomUUID().toString();
        String body = objectMapper.writeValueAsString(Map.of(
                "name", "Idempotent Chrome", "platform", "WEB", "app_version", "1.0.0"));

        MvcResult first = mockMvc.perform(post("/api/v1/devices").with(auth)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated()).andReturn();
        MvcResult replay = mockMvc.perform(post("/api/v1/devices").with(auth)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andExpect(header().string("Idempotent-Replay", "true"))
                .andReturn();
        assertThat(json(replay).get("id").asText())
                .isEqualTo(json(first).get("id").asText());

        // Same natural key with a different Idempotency-Key is still the same active device.
        MvcResult naturalReplay = mockMvc.perform(post("/api/v1/devices").with(auth)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andReturn();
        assertThat(json(naturalReplay).get("id").asText())
                .isEqualTo(json(first).get("id").asText());

        for (int i = 0; i < 4; i++) {
            mockMvc.perform(post("/api/v1/devices").with(auth)
                            .header("Idempotency-Key", UUID.randomUUID().toString())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of(
                                    "name", "Device " + i,
                                    "platform", "WEB",
                                    "app_version", "1.0.0"))))
                    .andExpect(status().isCreated());
        }
        MvcResult limited = mockMvc.perform(post("/api/v1/devices").with(auth)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Sixth", "platform", "WEB", "app_version", "1.0.0"))))
                .andExpect(status().isConflict())
                .andReturn();
        assertThat(json(limited).get("code").asText()).isEqualTo("DEVICE_LIMIT_REACHED");
        CONTRACT.assertValid("Error", json(limited));
    }

    @Test
    void workspaceCreationIsIdempotentAndForeignAccessIsForbidden() throws Exception {
        String subject = KeycloakTestSupport.uniqueSubject("kc-ws");
        var auth = KeycloakTestSupport.keycloakJwt(subject,
                KeycloakTestSupport.uniqueEmail("ws"), "ws-user", "Workspace User");
        String deviceId = registerDevice(auth, "Workspace Chrome");
        String key = UUID.randomUUID().toString();
        String body = objectMapper.writeValueAsString(Map.of(
                "name", "Idempotent Workspace " + UUID.randomUUID(),
                "security_mode", "MANAGED"));

        MvcResult first = mockMvc.perform(post("/api/v1/workspaces").with(auth)
                        .header("X-Device-Id", deviceId)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated()).andReturn();
        MvcResult replay = mockMvc.perform(post("/api/v1/workspaces").with(auth)
                        .header("X-Device-Id", deviceId)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andExpect(header().string("Idempotent-Replay", "true"))
                .andReturn();
        assertThat(json(replay).get("id").asText())
                .isEqualTo(json(first).get("id").asText());

        String foreignSubject = KeycloakTestSupport.uniqueSubject("kc-foreign");
        var foreignAuth = KeycloakTestSupport.keycloakJwt(foreignSubject,
                KeycloakTestSupport.uniqueEmail("foreign"), "foreign-user", "Foreign User");
        String foreignDevice = registerDevice(foreignAuth, "Foreign Chrome");
        MvcResult forbidden = mockMvc.perform(get("/api/v1/workspaces/{id}/chats",
                        json(first).get("id").asText())
                        .with(foreignAuth)
                        .header("X-Device-Id", foreignDevice))
                .andExpect(status().isForbidden())
                .andReturn();
        CONTRACT.assertValid("Error", json(forbidden));

        // Another user's /me must not leak this workspace (RLS + active membership filter).
        MvcResult foreignMe = mockMvc.perform(get("/api/v1/me").with(foreignAuth))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(foreignMe).get("workspaces")).isEmpty();
    }

    @Test
    void deviceBindingRejectsMissingForeignAndRevokedDevices() throws Exception {
        String subject = KeycloakTestSupport.uniqueSubject("kc-bind");
        var auth = KeycloakTestSupport.keycloakJwt(subject,
                KeycloakTestSupport.uniqueEmail("bind"), "bind-user", "Bind User");
        String deviceId = registerDevice(auth, "Bind Chrome");
        String workspaceId = createWorkspace(auth, deviceId);

        MvcResult missing = mockMvc.perform(get("/api/v1/workspaces/{id}/chats", workspaceId)
                        .with(auth))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(missing, "UNAUTHENTICATED");

        MvcResult foreignDevice = mockMvc.perform(get("/api/v1/workspaces/{id}/chats", workspaceId)
                        .with(auth)
                        .header("X-Device-Id", UUID.randomUUID().toString()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(foreignDevice, "UNAUTHENTICATED");

        migrator().update("UPDATE auth.devices SET status = 'REVOKED' WHERE id = ?",
                UUID.fromString(deviceId));
        MvcResult revoked = mockMvc.perform(get("/api/v1/workspaces/{id}/chats", workspaceId)
                        .with(auth)
                        .header("X-Device-Id", deviceId))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(revoked, "UNAUTHENTICATED");
    }

    @Test
    void removedMembershipDisappearsFromMe() throws Exception {
        String subject = KeycloakTestSupport.uniqueSubject("kc-removed");
        var auth = KeycloakTestSupport.keycloakJwt(subject,
                KeycloakTestSupport.uniqueEmail("removed"), "removed-user", "Removed User");
        String deviceId = registerDevice(auth, "Removed Chrome");
        String workspaceId = createWorkspace(auth, deviceId);
        UUID userId = UUID.fromString(json(mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk()).andReturn()).get("user").get("id").asText());

        migrator().update("UPDATE workspace.memberships SET status = 'REMOVED'"
                        + " WHERE workspace_id = ? AND user_id = ?",
                UUID.fromString(workspaceId), userId);

        MvcResult me = mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(me).get("workspaces")).isEmpty();
        assertThat(json(me).get("default_workspace_id").isNull()).isTrue();
    }

    private String registerDevice(org.springframework.test.web.servlet.request.RequestPostProcessor auth,
                                  String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/devices").with(auth)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", name, "platform", "WEB", "app_version", "1.0.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        return json(result).get("id").asText();
    }

    private String createWorkspace(
            org.springframework.test.web.servlet.request.RequestPostProcessor auth,
            String deviceId) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces").with(auth)
                        .header("X-Device-Id", deviceId)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Bind Workspace " + UUID.randomUUID(),
                                "security_mode", "MANAGED"))))
                .andExpect(status().isCreated())
                .andReturn();
        return json(result).get("id").asText();
    }

    private void assertError(MvcResult result, String code) throws Exception {
        JsonNode body = json(result);
        assertThat(body.get("code").asText()).isEqualTo(code);
        assertThat(body.get("message").asText()).isNotBlank();
        assertThat(body.has("details")).isTrue();
        assertThat(body.get("request_id").asText()).isNotBlank();
    }
}
