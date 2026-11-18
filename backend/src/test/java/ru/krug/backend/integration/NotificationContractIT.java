package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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

/** Real E6-B responses validated against contracts/openapi.yaml (the file is never edited). */
@ActiveProfiles("test")
class NotificationContractIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void notificationPagePreferencesAndPatchMatchTheContract() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (chat_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, alice.chat().id(), alice.workspace().id(), bob.user().id());
        sendMessage(alice, alice.chat().id(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "contract");

        MvcResult pageResult = mockMvc.perform(authed(get("/api/v1/notifications"), bob))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode page = json(pageResult);
        CONTRACT.assertValid("NotificationPage", page);
        CONTRACT.assertValid("Notification", page.get("items").get(0));

        MvcResult emptyPrefs = mockMvc.perform(authed(
                        get("/api/v1/notification-preferences"), bob))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("NotificationPreferences", json(emptyPrefs));

        MvcResult patchResult = mockMvc.perform(authed(
                        patch("/api/v1/notification-preferences"), bob)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "chat_id", alice.chat().id().toString(),
                                "type", "MESSAGE",
                                "channel", "IN_APP",
                                "mode", "ALL"))))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("NotificationPreference", json(patchResult));

        MvcResult prefsResult = mockMvc.perform(authed(
                        get("/api/v1/notification-preferences"), bob))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode prefs = json(prefsResult);
        CONTRACT.assertValid("NotificationPreferences", prefs);
        assertThat(prefs.get("items").size()).isEqualTo(1);
    }
}
