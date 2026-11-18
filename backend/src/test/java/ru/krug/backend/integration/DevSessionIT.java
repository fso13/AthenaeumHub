package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

@ActiveProfiles("test")
class DevSessionIT extends IntegrationTestBase {

    @Test
    void healthIsPublic() throws Exception {
        mockMvc.perform(get("/api/v1/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    @Test
    void bootstrapsUserWorkspaceChatAndDevice() throws Exception {
        SessionResponse session = devSession("Дмитрий-" + java.util.UUID.randomUUID());

        assertThat(session.accessToken()).isNotBlank();
        assertThat(session.expiresAt()).isAfter(java.time.Instant.now());
        assertThat(session.user().id()).isNotNull();
        assertThat(session.user().displayName()).startsWith("Дмитрий-");
        assertThat(session.device().platform()).isEqualTo("WEB");
        assertThat(session.workspace().securityMode()).isEqualTo("MANAGED");
        assertThat(session.chat().type()).isEqualTo("GROUP");

        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM workspace.memberships WHERE workspace_id = ? AND user_id = ?"
                        + " AND status = 'ACTIVE' AND role = 'OWNER'",
                Integer.class, session.workspace().id(), session.user().id())).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM chat.chat_members WHERE chat_id = ? AND user_id = ?"
                        + " AND status = 'ACTIVE'",
                Integer.class, session.chat().id(), session.user().id())).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.devices WHERE id = ? AND user_id = ?",
                Integer.class, session.device().id(), session.user().id())).isEqualTo(1);
    }

    @Test
    void repeatedCallsReuseTheSameTenancy() throws Exception {
        String name = uniqueDisplayName("reuse");
        SessionResponse first = devSession(name);
        SessionResponse second = devSession(name);

        assertThat(second.user().id()).isEqualTo(first.user().id());
        assertThat(second.workspace().id()).isEqualTo(first.workspace().id());
        assertThat(second.chat().id()).isEqualTo(first.chat().id());
        assertThat(second.device().id()).isEqualTo(first.device().id());
        assertThat(second.accessToken()).isNotEqualTo(first.accessToken());
    }

    @Test
    void differentDisplayNameCreatesDifferentTenancy() throws Exception {
        SessionResponse first = devSession(uniqueDisplayName("alice"));
        SessionResponse second = devSession(uniqueDisplayName("bob"));

        assertThat(second.user().id()).isNotEqualTo(first.user().id());
        assertThat(second.workspace().id()).isNotEqualTo(first.workspace().id());
        assertThat(second.chat().id()).isNotEqualTo(first.chat().id());
    }

    @Test
    void sessionWithoutBodyUsesDefaultDisplayName() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/dev/session"))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(result).get("user").get("display_name").asText()).isEqualTo("Дмитрий");
    }

    @Test
    void rejectsDisplayNameLongerThan80Chars() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/dev/session")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("display_name", "x".repeat(81)))))
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    @Test
    void echoesClientRequestId() throws Exception {
        mockMvc.perform(get("/api/v1/health").header("X-Request-Id", "req_test_123"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Request-Id", "req_test_123"));
    }
}
