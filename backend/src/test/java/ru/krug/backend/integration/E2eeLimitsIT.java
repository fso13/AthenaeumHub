package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E7-B1F regression coverage for the review-04 P1-02/P1-06/P1-07/P2-04/P2-05/P2-06/P2-11/
 * P2-13 findings: cross-user identity conflicts (409, never 404/500), device limit,
 * NO_SPK, DIRECT repeat/race (200), GROUP idempotency, null prekey elements, key-change
 * verification and cross-workspace claim.
 */
@ActiveProfiles("test")
class E2eeLimitsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void crossUserIdentityBundleIsConflictNotNotFound() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        SessionResponse carol = devSession();
        joinWorkspace(alice, bob);
        Material aliceKeys = DeviceKeyTestSupport.generate();
        JsonNode aliceDevice = register(alice, "alice-owned", aliceKeys);
        UUID aliceDeviceId = UUID.fromString(aliceDevice.get("id").asText());
        // A common chat makes Alice's ACTIVE device visible to Bob via RLS p_devices_chat_peer,
        // which is exactly the P1-02 scenario: the old unscoped lookup answered 404.
        createDirect(alice, bob, null);

        // Bob submits Alice's valid public bundle as his own device.
        JsonNode conflict = expectError(post("/api/v1/devices"), bob,
                aliceKeys.registrationBody("bob-copy", "0.7.0"), 409);
        assertThat(conflict.get("code").asText()).isEqualTo("IDENTITY_KEY_CONFLICT");
        // Not created, not mutated, and not listed for Bob.
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.devices
                 WHERE user_id = ? AND id = ?
                """, Integer.class, bob.user().id(), aliceDeviceId)).isZero();
        JsonNode bobDevices = json(mockMvc.perform(authed(get("/api/v1/devices"), bob))
                .andExpect(status().isOk()).andReturn());
        assertThat(bobDevices.get("items").toString()).doesNotContain(aliceDeviceId.toString());
        // Alice's row is untouched (same fingerprint and key_generation).
        JsonNode aliceDevices = json(mockMvc.perform(authed(get("/api/v1/devices"), alice))
                .andExpect(status().isOk()).andReturn());
        JsonNode stored = findById(aliceDevices.get("items"), aliceDeviceId);
        assertThat(stored.get("fingerprint").asText())
                .isEqualTo(aliceDevice.get("fingerprint").asText());
        assertThat(stored.get("key_generation").asInt()).isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.devices
                 WHERE identity_signing_key = decode(?, 'hex')
                """, Integer.class, hex(aliceKeys.identitySigningKey()))).isEqualTo(1);

        // Cross-workspace public bundle: still a global-uniqueness conflict, never 404.
        JsonNode crossTenant = expectError(post("/api/v1/devices"), carol,
                aliceKeys.registrationBody("carol-copy", "0.7.0"), 409);
        assertThat(crossTenant.get("code").asText()).isEqualTo("IDENTITY_KEY_CONFLICT");
    }

    @Test
    void sixthActiveDeviceIsRejectedWithDeviceLimit() throws Exception {
        SessionResponse alice = devSession();
        for (int index = 0; index < 4; index++) {
            register(alice, "limit-" + index, DeviceKeyTestSupport.generate());
        }
        JsonNode error = expectError(post("/api/v1/devices"), alice,
                DeviceKeyTestSupport.generate().registrationBody("limit-5", "0.7.0"), 409);
        assertThat(error.get("code").asText()).isEqualTo("DEVICE_LIMIT_REACHED");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.devices WHERE user_id = ? AND status = 'ACTIVE'
                """, Integer.class, alice.user().id())).isEqualTo(5);
    }

    @Test
    void expiredSignedPrekeyIsReportedAsNoSpkAndHealthyDeviceStillClaims() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        Material aliceKeys = DeviceKeyTestSupport.generate();
        UUID aliceDevice = UUID.fromString(register(alice, "alice-spk", aliceKeys)
                .get("id").asText());
        Material expiredKeys = DeviceKeyTestSupport.generate();
        UUID expiredDevice = UUID.fromString(register(bob, "bob-expired", expiredKeys)
                .get("id").asText());
        UUID healthyDevice = UUID.fromString(register(bob, "bob-healthy",
                DeviceKeyTestSupport.generate()).get("id").asText());
        UUID chatId = createDirect(alice, bob, "E2EE");
        migrator().update("""
                UPDATE auth.device_prekeys SET expires_at = now() - interval '1 day'
                 WHERE device_id = ? AND kind = 'SIGNED'
                """, expiredDevice);

        String aliceToken = tokenFor(alice, aliceDevice);
        Map<String, Object> body = Map.of("chat_id", chatId.toString(), "devices", List.of(
                Map.of("device_id", expiredDevice.toString(), "user_id", bob.user().id().toString()),
                Map.of("device_id", healthyDevice.toString(), "user_id", bob.user().id().toString())));
        JsonNode claim = json(mockMvc.perform(authed(post("/api/v1/keys/claim"), aliceToken,
                        aliceDevice)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("KeyClaimResponse", claim);
        assertThat(claim.get("bundles").size()).isEqualTo(1);
        assertThat(claim.get("bundles").get(0).get("device_id").asText())
                .isEqualTo(healthyDevice.toString());
        assertThat(claim.get("unavailable").size()).isEqualTo(1);
        assertThat(claim.get("unavailable").get(0).get("device_id").asText())
                .isEqualTo(expiredDevice.toString());
        assertThat(claim.get("unavailable").get(0).get("reason").asText()).isEqualTo("NO_SPK");
    }

    @Test
    void repeatedDirectCreateReturns200WithTheSameChat() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);

        UUID first = createManagedDirect(alice, bob, 201);
        UUID second = createManagedDirect(alice, bob, 200);
        assertThat(second).isEqualTo(first);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chats
                 WHERE workspace_id = ? AND type = 'DIRECT' AND deleted_at IS NULL
                   AND direct_key = ?
                """, Integer.class, alice.workspace().id(),
                DirectPairKey.of(alice.user().id(), bob.user().id()))).isEqualTo(1);
    }

    @Test
    void concurrentDirectCreateProducesOneChatAndNo500() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Integer> call = () -> createManagedDirectStatus(alice, bob);
            List<Future<Integer>> futures = new ArrayList<>();
            futures.add(pool.submit(call));
            futures.add(pool.submit(call));
            List<Integer> statuses = new ArrayList<>();
            UUID chatId = null;
            for (Future<Integer> future : futures) {
                statuses.add(future.get(20, TimeUnit.SECONDS));
            }
            assertThat(statuses).containsExactlyInAnyOrder(200, 201);
            List<UUID> ids = migrator().queryForList("""
                    SELECT id FROM chat.chats
                     WHERE workspace_id = ? AND type = 'DIRECT' AND deleted_at IS NULL
                       AND direct_key = ?
                    """, UUID.class, alice.workspace().id(),
                    DirectPairKey.of(alice.user().id(), bob.user().id()));
            assertThat(ids).hasSize(1);
            chatId = ids.get(0);
            assertThat(chatId).isNotNull();
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void groupCreateIsIdempotentByKey() throws Exception {
        SessionResponse alice = devSession();
        UUID key = UUID.randomUUID();
        UUID first = createGroup(alice, "Idempotent group", key);
        UUID replay = createGroup(alice, "Idempotent group", key);
        assertThat(replay).isEqualTo(first);
        UUID other = createGroup(alice, "Idempotent group", UUID.randomUUID());
        assertThat(other).isNotEqualTo(first);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chats WHERE workspace_id = ? AND type = 'GROUP'
                   AND name = 'Idempotent group'
                """, Integer.class, alice.workspace().id())).isEqualTo(2);
    }

    @Test
    void nullOneTimePrekeyElementIsRejectedWithoutServerError() throws Exception {
        SessionResponse alice = devSession();
        String body = "{\"name\":\"null-prekey-" + UUID.randomUUID()
                + "\",\"platform\":\"WEB\",\"app_version\":\"0.7.0\","
                + "\"one_time_prekeys\":[null]}";
        MvcResult result = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + alice.accessToken())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isIn(400, 422);
        JsonNode error = json(result);
        assertThat(error.get("code").asText()).isEqualTo("INVALID_KEY_FORMAT");
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.devices WHERE name LIKE 'null-prekey-%'",
                Integer.class)).isZero();
    }

    @Test
    void verificationRejectsStaleGenerationAndReplaysTheSameRow() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        UUID aliceDevice = UUID.fromString(register(alice, "verify-alice",
                DeviceKeyTestSupport.generate()).get("id").asText());
        UUID bobDevice = UUID.fromString(register(bob, "verify-bob",
                DeviceKeyTestSupport.generate()).get("id").asText());
        UUID chatId = createDirect(alice, bob, "E2EE");
        String aliceToken = tokenFor(alice, aliceDevice);

        // P2-05: the verifier saw generation 2 but the device is at 1 -> 409 KEY_CHANGED.
        JsonNode changed = putVerification(aliceToken, aliceDevice, chatId,
                verificationBody(bobDevice, 2, 2), UUID.randomUUID(), 409);
        assertThat(changed.get("code").asText()).isEqualTo("KEY_CHANGED");
        assertThat(changed.get("details").get("actual").asInt()).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.key_verifications WHERE chat_id = ?",
                Integer.class, chatId)).isZero();

        UUID key = UUID.randomUUID();
        Map<String, Object> body = verificationBody(bobDevice, 2, 1);
        JsonNode first = putVerification(aliceToken, aliceDevice, chatId, body, key, 201);
        JsonNode replay = putVerification(aliceToken, aliceDevice, chatId, body, key, 201);
        assertThat(replay.get("verified_at").asText())
                .isEqualTo(first.get("verified_at").asText());
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.key_verifications WHERE chat_id = ?",
                Integer.class, chatId)).isEqualTo(1);

        // P2-04: verified is only valid for the verified generation.
        migrator().update("UPDATE auth.devices SET key_generation = 2 WHERE id = ?", bobDevice);
        JsonNode stale = chatKeys(aliceToken, aliceDevice, chatId);
        assertThat(findByDeviceId(stale.get("devices"), bobDevice).get("verified").isNull())
                .isTrue();
        assertThat(stale.get("verified_count").asInt()).isZero();
        migrator().update("UPDATE auth.devices SET key_generation = 1 WHERE id = ?", bobDevice);
        JsonNode current = chatKeys(aliceToken, aliceDevice, chatId);
        assertThat(findByDeviceId(current.get("devices"), bobDevice).get("verified").asBoolean())
                .isTrue();
        assertThat(current.get("verified_count").asInt()).isEqualTo(1);
    }

    @Test
    void crossWorkspaceClaimDoesNotLeakDevices() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        SessionResponse carol = devSession();
        Material bobKeys = DeviceKeyTestSupport.generate();
        UUID bobDevice = UUID.fromString(register(bob, "xws-bob", bobKeys).get("id").asText());
        // Carol's workspace chat; Alice is neither member nor workspace member.
        joinWorkspace(carol, bob);
        UUID foreignChat = createDirect(carol, bob, "E2EE");
        String aliceToken = tokenFor(alice, alice.device().id());
        Map<String, Object> body = Map.of("chat_id", foreignChat.toString(), "devices",
                List.of(Map.of("device_id", bobDevice.toString(),
                        "user_id", bob.user().id().toString())));
        JsonNode error = json(mockMvc.perform(authed(post("/api/v1/keys/claim"), aliceToken,
                        alice.device().id())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isForbidden()).andReturn());
        assertThat(error.get("code").asText()).isEqualTo("FORBIDDEN");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys
                 WHERE device_id = ? AND consumed_at IS NOT NULL
                """, Integer.class, bobDevice)).isZero();
    }

    @Test
    void groupCreateResponseCarriesNoPeerAndNoCapability() throws Exception {
        SessionResponse alice = devSession();
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        alice.workspace().id()), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "GROUP",
                                "name", "group-shape"))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode chat = json(result);
        CONTRACT.assertValid("Chat", chat);
        assertThat(chat.get("peer_id").isNull()).isTrue();
        assertThat(chat.get("peer_has_e2ee_capable_devices").asBoolean()).isFalse();
    }

    // ---------------------------------------------------------------------

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

    private int createManagedDirectStatus(SessionResponse alice, SessionResponse bob)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        alice.workspace().id()), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                                "peer_id", bob.user().id().toString()))))
                .andReturn();
        return result.getResponse().getStatus();
    }

    private UUID createManagedDirect(SessionResponse alice, SessionResponse bob, int expected)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        alice.workspace().id()), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                                "peer_id", bob.user().id().toString()))))
                .andExpect(status().is(expected))
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private UUID createGroup(SessionResponse session, String name, UUID key) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        session.workspace().id()), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "GROUP",
                                "name", name))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
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

    private Map<String, Object> verificationBody(UUID targetDeviceId, int vhVersion,
                                                 int expectedGeneration) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("device_id", targetDeviceId.toString());
        body.put("method", "MANUAL");
        body.put("vh_version", vhVersion);
        body.put("safety_number_hash", Base64Url.encode(new byte[32]));
        body.put("expected_key_generation", expectedGeneration);
        return body;
    }

    private JsonNode putVerification(String token, UUID deviceId, UUID chatId,
                                     Map<String, Object> body, UUID idempotencyKey,
                                     int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        put("/api/v1/chats/{id}/keys/verification", chatId), token, deviceId)
                        .header("Idempotency-Key", idempotencyKey)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private JsonNode chatKeys(String token, UUID deviceId, UUID chatId) throws Exception {
        return json(mockMvc.perform(authed(get("/api/v1/chats/{id}/keys", chatId), token,
                        deviceId))
                .andExpect(status().isOk()).andReturn());
    }

    private JsonNode expectError(MockHttpServletRequestBuilder request, SessionResponse session,
                                 Object body, int expected) throws Exception {
        MvcResult result = mockMvc.perform(request
                        .header("Authorization", "Bearer " + session.accessToken())
                        .header("X-Device-Id", session.device().id().toString())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private void joinWorkspace(SessionResponse owner, SessionResponse member) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, owner.workspace().id(), member.user().id());
    }

    /** Managed DIRECT via the API; E2EE fixture via SQL (flag off blocks E2EE creation). */
    private UUID createDirect(SessionResponse alice, SessionResponse bob, String mode)
            throws Exception {
        if (mode == null) {
            return createManagedDirect(alice, bob, 201);
        }
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, direct_key)
                VALUES (?, ?, 'DIRECT', ?, NULL, ?, ?)
                """, chatId, alice.workspace().id(), mode, alice.user().id(),
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

    private static JsonNode findById(JsonNode items, UUID id) {
        for (JsonNode item : items) {
            if (id.toString().equals(item.get("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("device not found: " + id);
    }

    private static JsonNode findByDeviceId(JsonNode items, UUID id) {
        for (JsonNode item : items) {
            if (id.toString().equals(item.get("device_id").asText())) {
                return item;
            }
        }
        throw new AssertionError("device not found: " + id);
    }

    private static String hex(byte[] value) {
        return java.util.HexFormat.of().formatHex(value);
    }
}
