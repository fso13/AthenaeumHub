package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E7-B1F P1-01: {@code POST /keys/claim} is bounded per caller, per chat and per target
 * device. A limited request consumes no one-time prekey; the message-send limiter is a
 * separate window set and stays intact.
 */
@SpringBootTest(properties = {
        "krug.rate-limit.claim-per-user=3",
        "krug.rate-limit.claim-per-chat=1000",
        "krug.rate-limit.claim-user-window=60s",
        "krug.rate-limit.claim-chat-window=60s"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
class E2eeClaimRateLimitIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void claimIsLimitedPerUserWithoutBurningPrekeysAndMessagesStillSend() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        Material aliceKeys = DeviceKeyTestSupport.generate();
        Material bobKeys = DeviceKeyTestSupport.generate();
        UUID aliceDevice = UUID.fromString(register(alice, "alice-rl", aliceKeys)
                .get("id").asText());
        UUID bobDevice = UUID.fromString(register(bob, "bob-rl", bobKeys).get("id").asText());
        UUID chatId = createE2eeDirect(alice, bob);
        assertThat(bobKeys.oneTimePrekeys()).hasSize(2);

        String aliceToken = tokenFor(alice, aliceDevice);
        JsonNode first = claim(aliceToken, aliceDevice, chatId, bob.user().id(), bobDevice, 200);
        CONTRACT.assertValid("KeyClaimResponse", first);
        JsonNode second = claim(aliceToken, aliceDevice, chatId, bob.user().id(), bobDevice, 200);
        assertThat(second.get("bundles").get(0).get("one_time_prekey").isNull()).isFalse();
        JsonNode third = claim(aliceToken, aliceDevice, chatId, bob.user().id(), bobDevice, 200);
        assertThat(third.get("bundles").get(0).get("one_time_prekey").isNull()).isTrue();
        assertThat(third.get("bundles").get(0).get("otp_exhausted").asBoolean()).isTrue();

        // Fourth claim in the window -> 429 with Retry-After, and no extra OPK is consumed.
        MvcResult limited = mockMvc.perform(authed(post("/api/v1/keys/claim"), aliceToken,
                        aliceDevice)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(claimBody(chatId,
                                bob.user().id(), bobDevice))))
                .andExpect(status().isTooManyRequests())
                .andReturn();
        JsonNode error = json(limited);
        assertThat(error.get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(error.get("details").get("scope").asText()).isEqualTo("user");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
        assertThat(Long.parseLong(limited.getResponse().getHeader("Retry-After")))
                .isGreaterThanOrEqualTo(1);
        assertThat(consumedPrekeys(bobDevice)).isEqualTo(2);

        // A different caller is unaffected: per-user windows are independent. Bob claims
        // Alice's device in the same chat and still gets her prekey bundle.
        JsonNode bobClaim = claim(tokenFor(bob, bobDevice), bobDevice, chatId,
                alice.user().id(), aliceDevice, 200);
        assertThat(bobClaim.get("bundles").get(0).get("device_id").asText())
                .isEqualTo(aliceDevice.toString());
        assertThat(bobClaim.get("bundles").get(0).get("one_time_prekey").isNull()).isFalse();
        assertThat(consumedPrekeys(bobDevice)).isEqualTo(2);

        // The message-send limiter has its own windows: a managed send still succeeds.
        MvcResult sent = mockMvc.perform(authed(post("/api/v1/chats/{id}/messages",
                        alice.chat().id()), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "still sends", null)))
                .andExpect(status().isCreated())
                .andReturn();
        assertThat(json(sent).get("seq").asInt()).isEqualTo(1);
    }

    private JsonNode claim(String token, UUID deviceId, UUID chatId, UUID userId,
                           UUID targetDevice, int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/keys/claim"), token, deviceId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(claimBody(chatId, userId,
                                targetDevice))))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private static Map<String, Object> claimBody(UUID chatId, UUID userId, UUID targetDevice) {
        return Map.of("chat_id", chatId.toString(), "devices",
                List.of(Map.of("device_id", targetDevice.toString(),
                        "user_id", userId.toString())));
    }

    private long consumedPrekeys(UUID deviceId) {
        return migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys
                 WHERE device_id = ? AND kind = 'ONE_TIME' AND consumed_at IS NOT NULL
                """, Long.class, deviceId);
    }

    private JsonNode register(SessionResponse session, String name, Material material)
            throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + session.accessToken())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                material.registrationBody(name, "0.7.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        return json(result);
    }

    private String tokenFor(SessionResponse session, UUID deviceId) {
        return tokenIssuer.issue(session.user().id(), deviceId, session.workspace().id())
                .accessToken();
    }

    private MockHttpServletRequestBuilder authed(MockHttpServletRequestBuilder builder,
                                                 String token, UUID deviceId) {
        return builder.header("Authorization", "Bearer " + token)
                .header("X-Device-Id", deviceId.toString());
    }

    private void joinWorkspace(SessionResponse owner, SessionResponse member) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, owner.workspace().id(), member.user().id());
    }

    private UUID createE2eeDirect(SessionResponse alice, SessionResponse bob) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, direct_key)
                VALUES (?, ?, 'DIRECT', 'E2EE', NULL, ?, ?)
                """, chatId, alice.workspace().id(), alice.user().id(),
                DirectPairKey.of(alice.user().id(), bob.user().id()));
        for (SessionResponse member : List.of(alice, bob)) {
            migrator().update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'ACTIVE')
                    """, chatId, alice.workspace().id(), member.user().id(),
                    member == alice ? "OWNER" : "MEMBER");
        }
        migrator().update("INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)",
                chatId, alice.workspace().id());
        return chatId;
    }
}
