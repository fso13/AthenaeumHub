package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
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
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E7-B1 / I-01 integration coverage: legacy/full/partial device registration, prekeys,
 * claim/OTP consume, chat keys + verification, flag-off and contract shapes. E2EE message
 * send/fan-out is out of scope and must answer 409 E2EE_DISABLED.
 */
@ActiveProfiles("test")
class E2eeDeviceKeyIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void legacyRegistrationStaysCompatibleAndPartialKeysAreRejected() throws Exception {
        SessionResponse alice = devSession();
        String name = "legacy-" + UUID.randomUUID();

        MvcResult legacy = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + alice.accessToken())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", name, "platform", "WEB", "app_version", "0.7.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode legacyDevice = json(legacy);
        CONTRACT.assertValid("Device", legacyDevice);
        assertThat(legacyDevice.get("e2ee_capable").asBoolean()).isFalse();
        assertThat(legacyDevice.get("identity_key_alg").asText()).isEqualTo("LEGACY");
        assertThat(legacyDevice.get("key_generation").asInt()).isEqualTo(1);
        assertThat(legacyDevice.get("identity_signing_key").isNull()).isTrue();

        MvcResult list = mockMvc.perform(authed(get("/api/v1/devices"), alice))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode devices = json(list);
        CONTRACT.assertValid("DeviceList", devices);
        assertThat(devices.get("items").size()).isGreaterThanOrEqualTo(2);
        assertThat(devices.get("items").toString()).contains(name);

        Material material = DeviceKeyTestSupport.generate();
        Map<String, Object> partial = new LinkedHashMap<>();
        partial.put("name", "partial-" + UUID.randomUUID());
        partial.put("platform", "WEB");
        partial.put("app_version", "0.7.0");
        partial.put("identity_signing_key",
                ru.krug.backend.shared.application.model.Base64Url.encode(
                        material.identitySigningKey()));
        JsonNode error = expectError(post("/api/v1/devices"), alice, partial, 422);
        assertThat(error.get("code").asText()).isEqualTo("INVALID_KEY_FORMAT");
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.devices WHERE name = ?", Integer.class,
                partial.get("name"))).isZero();
    }

    @Test
    void fullKeysCreateCapableDeviceAndRejectBadSignatures() throws Exception {
        SessionResponse alice = devSession();
        Material material = DeviceKeyTestSupport.generate();

        JsonNode device = register(alice, "keyed-" + UUID.randomUUID(), material);
        CONTRACT.assertValid("Device", device);
        assertThat(device.get("e2ee_capable").asBoolean()).isTrue();
        assertThat(device.get("identity_key_alg").asText()).isEqualTo("Ed25519+X25519");
        assertThat(device.get("key_generation").asInt()).isEqualTo(1);
        assertThat(device.get("fingerprint").asText()).isEqualTo(
                ru.krug.backend.shared.application.model.Base64Url.encode(
                        material.fingerprint()));
        assertThat(device.get("signed_prekey").get("key_id").asText())
                .isEqualTo(material.spkId());
        assertThat(device.get("one_time_prekeys_available").asInt()).isEqualTo(2);

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys
                 WHERE device_id = ? AND kind = 'SIGNED' AND consumed_at IS NULL
                """, Integer.class, UUID.fromString(device.get("id").asText()))).isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys
                 WHERE device_id = ? AND kind = 'ONE_TIME'
                """, Integer.class, UUID.fromString(device.get("id").asText()))).isEqualTo(2);

        // Same identity pair -> same immutable device, even with a new Idempotency-Key.
        JsonNode replay = register(alice, "keyed-other-name", material);
        assertThat(replay.get("id").asText()).isEqualTo(device.get("id").asText());
        assertThat(replay.get("name").asText()).isEqualTo(device.get("name").asText());

        // Bad SPK signature -> 422 INVALID_SPK_SIGNATURE, nothing saved.
        Material badSpk = DeviceKeyTestSupport.generate();
        Map<String, Object> badSpkBody = new LinkedHashMap<>(
                badSpk.registrationBody("bad-spk-" + UUID.randomUUID(), "0.7.0"));
        @SuppressWarnings("unchecked")
        Map<String, Object> spk = new LinkedHashMap<>(
                (Map<String, Object>) badSpkBody.get("signed_prekey"));
        spk.put("signature", ru.krug.backend.shared.application.model.Base64Url.encode(
                new byte[64]));
        badSpkBody.put("signed_prekey", spk);
        JsonNode spkError = expectError(post("/api/v1/devices"), alice, badSpkBody, 422);
        assertThat(spkError.get("code").asText()).isEqualTo("INVALID_SPK_SIGNATURE");

        // Bad binding signature -> 422 INVALID_IDENTITY_BINDING.
        Material badBinding = DeviceKeyTestSupport.generate();
        Map<String, Object> bindingBody = badBinding.registrationBody(
                "bad-binding-" + UUID.randomUUID(), "0.7.0");
        bindingBody.put("identity_binding_signature",
                ru.krug.backend.shared.application.model.Base64Url.encode(new byte[64]));
        JsonNode bindingError = expectError(post("/api/v1/devices"), alice, bindingBody, 422);
        assertThat(bindingError.get("code").asText()).isEqualTo("INVALID_IDENTITY_BINDING");
    }

    @Test
    void revokeIsTerminalAndKeyGenerationAdvances() throws Exception {
        SessionResponse alice = devSession();
        Material material = DeviceKeyTestSupport.generate();
        JsonNode device = register(alice, "revoke-" + UUID.randomUUID(), material);
        UUID deviceId = UUID.fromString(device.get("id").asText());

        mockMvc.perform(authed(delete("/api/v1/devices/{id}", deviceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID()))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(delete("/api/v1/devices/{id}", deviceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID()))
                .andExpect(status().isNoContent());

        JsonNode list = json(mockMvc.perform(authed(get("/api/v1/devices"), alice))
                .andExpect(status().isOk()).andReturn());
        JsonNode revoked = findById(list.get("items"), deviceId);
        assertThat(revoked.get("status").asText()).isEqualTo("REVOKED");
        assertThat(revoked.get("key_generation").asInt()).isEqualTo(2);
        assertThat(revoked.get("e2ee_capable").asBoolean()).isFalse();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys WHERE device_id = ?
                """, Integer.class, deviceId)).isZero();

        // The same pair can never be resurrected (P2-5).
        JsonNode error = expectError(post("/api/v1/devices"), alice,
                material.registrationBody("revive-" + UUID.randomUUID(), "0.7.0"), 410);
        assertThat(error.get("code").asText()).isEqualTo("DEVICE_REVOKED");
    }

    @Test
    void prekeysUploadRotateAndConflict() throws Exception {
        SessionResponse alice = devSession();
        Material material = DeviceKeyTestSupport.generate();
        UUID deviceId = UUID.fromString(register(alice, "prekeys-" + UUID.randomUUID(), material)
                .get("id").asText());
        String token = tokenFor(alice, deviceId);

        Map<String, Object> upload = material.prekeyUploadBody(3, "spk-rotated-" + UUID.randomUUID());
        JsonNode result = uploadPrekeys(token, deviceId, upload, 200);
        CONTRACT.assertValid("PrekeyUploadResult", result);
        assertThat(result.get("one_time_prekeys_stored").asInt()).isEqualTo(3);
        assertThat(result.get("one_time_prekeys_available").asInt()).isEqualTo(5);
        assertThat(result.get("signed_prekey_id").asText())
                .isEqualTo(((Map<?, ?>) upload.get("signed_prekey")).get("key_id"));

        JsonNode replay = uploadPrekeys(token, deviceId, upload, 200);
        assertThat(replay.get("one_time_prekeys_stored").asInt()).isZero();
        assertThat(replay.get("one_time_prekeys_available").asInt()).isEqualTo(5);

        // Same key_id with different (validly signed) bytes -> 409 PREKEY_ID_CONFLICT.
        String conflictId = "spk-conflict-" + UUID.randomUUID();
        uploadPrekeys(token, deviceId, material.prekeyUploadBody(0, conflictId), 200);
        JsonNode error = expectError(post("/api/v1/devices/{id}/prekeys", deviceId), token,
                deviceId, material.prekeyUploadBody(0, conflictId), 409);
        assertThat(error.get("code").asText()).isEqualTo("PREKEY_ID_CONFLICT");

        // A header that does not match the token's device is rejected by the binding
        // filter before the controller (dev tokens are device-bound).
        MvcResult mismatch = mockMvc.perform(post("/api/v1/devices/{id}/prekeys", deviceId)
                        .header("Authorization", "Bearer " + token)
                        .header("X-Device-Id", UUID.randomUUID().toString())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                material.prekeyUploadBody(1, "spk-foreign"))))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(json(mismatch).get("code").asText()).isEqualTo("UNAUTHENTICATED");

        // Legacy devices never receive keys in place (D-17): 422 E2EE_LEGACY_DEVICE.
        JsonNode legacyError = expectError(
                post("/api/v1/devices/{id}/prekeys", alice.device().id()), alice,
                material.prekeyUploadBody(0, "spk-legacy-" + UUID.randomUUID()), 422);
        assertThat(legacyError.get("code").asText()).isEqualTo("E2EE_LEGACY_DEVICE");

        // More than 200 outstanding OPKs is rejected before any write.
        JsonNode limitError = expectError(
                post("/api/v1/devices/{id}/prekeys", deviceId), token, deviceId,
                material.prekeyUploadBody(199, "spk-limit-" + UUID.randomUUID()), 422);
        assertThat(limitError.get("code").asText()).isEqualTo("PREKEY_LIMIT_EXCEEDED");
    }

    @Test
    void claimConsumesOneTimePrekeysAndHidesForeignDevices() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        SessionResponse carol = devSession();
        joinWorkspace(alice, bob);

        Material aliceKeys = DeviceKeyTestSupport.generate();
        Material bobKeys = DeviceKeyTestSupport.generate();
        UUID aliceDevice = UUID.fromString(register(alice, "alice-keyed", aliceKeys)
                .get("id").asText());
        UUID bobDevice = UUID.fromString(register(bob, "bob-keyed", bobKeys)
                .get("id").asText());
        UUID carolDevice = UUID.fromString(register(carol, "carol-keyed",
                DeviceKeyTestSupport.generate()).get("id").asText());

        UUID chatId = createDirect(alice, bob);
        String aliceToken = tokenFor(alice, aliceDevice);

        JsonNode first = claim(aliceToken, aliceDevice, chatId, bob.user().id(), bobDevice, 200);
        CONTRACT.assertValid("KeyClaimResponse", first);
        assertThat(first.get("bundles").size()).isEqualTo(1);
        JsonNode bundle = first.get("bundles").get(0);
        assertThat(bundle.get("device_id").asText()).isEqualTo(bobDevice.toString());
        assertThat(bundle.get("otp_exhausted").asBoolean()).isFalse();
        assertThat(bundle.get("one_time_prekey").get("key_id").asText()).isNotBlank();

        JsonNode second = claim(aliceToken, aliceDevice, chatId, bob.user().id(), bobDevice, 200);
        assertThat(second.get("bundles").get(0).get("otp_exhausted").asBoolean()).isFalse();
        JsonNode third = claim(aliceToken, aliceDevice, chatId, bob.user().id(), bobDevice, 200);
        assertThat(third.get("bundles").get(0).get("otp_exhausted").asBoolean()).isTrue();
        assertThat(third.get("bundles").get(0).get("one_time_prekey").isNull()).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys
                 WHERE device_id = ? AND kind = 'ONE_TIME' AND consumed_at IS NOT NULL
                """, Integer.class, bobDevice)).isEqualTo(2);

        // A legacy-only target yields unavailable NO_KEYS and, with no bundle, 409.
        JsonNode noBundles = claim(aliceToken, aliceDevice, chatId, alice.user().id(),
                alice.device().id(), 409);
        assertThat(noBundles.get("code").asText()).isEqualTo("NO_PREKEYS");
        assertThat(noBundles.get("details").get("devices").size()).isEqualTo(1);

        // Same answer for "not a member" and "does not exist" (422, whole request).
        JsonNode unknown = claim(aliceToken, aliceDevice, chatId, carol.user().id(),
                carolDevice, 422);
        assertThat(unknown.get("code").asText()).isEqualTo("UNKNOWN_DEVICE");
        // user_id must match the device owner.
        claim(aliceToken, aliceDevice, chatId, bob.user().id(), carolDevice, 422);

        // A non-member caller gets 403, not device details.
        claim(tokenFor(carol, carolDevice), carolDevice, chatId, bob.user().id(), bobDevice, 403);

        // RLS: Carol cannot read Bob's prekeys, even knowing the id.
        assertThat(inTenant(carol.user().id(), carol.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM auth.device_prekeys WHERE device_id = ?
                        """, Integer.class, bobDevice))).isZero();
    }

    @Test
    void chatKeysAndVerificationArePerVerifierDevice() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        Material aliceKeys = DeviceKeyTestSupport.generate();
        Material bobKeys = DeviceKeyTestSupport.generate();
        UUID aliceDevice = UUID.fromString(register(alice, "keys-alice", aliceKeys)
                .get("id").asText());
        UUID bobDevice = UUID.fromString(register(bob, "keys-bob", bobKeys)
                .get("id").asText());
        UUID chatId = createDirect(alice, bob, "E2EE");
        String aliceToken = tokenFor(alice, aliceDevice);

        MvcResult keysResult = mockMvc.perform(authed(get("/api/v1/chats/{id}/keys", chatId),
                        aliceToken, aliceDevice))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode keys = json(keysResult);
        CONTRACT.assertValid("ChatKeysResponse", keys);
        assertThat(keys.get("security_mode").asText()).isEqualTo("E2EE");
        assertThat(keys.get("my_device_id").asText()).isEqualTo(aliceDevice.toString());
        assertThat(keys.get("devices_total").asInt()).isEqualTo(2);
        JsonNode bobInfo = findByDeviceId(keys.get("devices"), bobDevice);
        assertThat(bobInfo.get("verified").isNull()).isTrue();
        assertThat(bobInfo.get("signed_prekey_id").asText()).isEqualTo(bobKeys.spkId());
        JsonNode selfInfo = findByDeviceId(keys.get("devices"), aliceDevice);
        assertThat(selfInfo.get("is_self").asBoolean()).isTrue();

        // vh_version != 2 is rejected before a row is written.
        Map<String, Object> badVh = verificationBody(bobDevice, 1);
        JsonNode vhError = putVerification(aliceToken, aliceDevice, chatId, badVh, 422);
        assertThat(vhError.get("code").asText()).isEqualTo("VH_VERSION_UNSUPPORTED");
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.key_verifications WHERE chat_id = ?",
                Integer.class, chatId)).isZero();

        Map<String, Object> body = verificationBody(bobDevice, 2);
        MvcResult verify = mockMvc.perform(authed(
                        put("/api/v1/chats/{id}/keys/verification", chatId), aliceToken,
                        aliceDevice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode verification = json(verify);
        CONTRACT.assertValid("VerificationResponse", verification);
        assertThat(verification.get("verifier_device_id").asText())
                .isEqualTo(aliceDevice.toString());

        JsonNode after = json(mockMvc.perform(authed(
                        get("/api/v1/chats/{id}/keys", chatId), aliceToken, aliceDevice))
                .andExpect(status().isOk()).andReturn());
        assertThat(findByDeviceId(after.get("devices"), bobDevice).get("verified").asBoolean())
                .isTrue();
        assertThat(after.get("verified_count").asInt()).isEqualTo(1);

        // Another verifier device does not inherit verified (P0-1).
        String bobToken = tokenFor(bob, bobDevice);
        JsonNode bobView = json(mockMvc.perform(authed(
                        get("/api/v1/chats/{id}/keys", chatId), bobToken, bobDevice))
                .andExpect(status().isOk()).andReturn());
        assertThat(findByDeviceId(bobView.get("devices"), bobDevice).get("verified").isNull())
                .isTrue();
        assertThat(bobView.get("verified_count").asInt()).isZero();

        // MANAGED chat has no key endpoints.
        UUID managedChat = alice.chat().id();
        JsonNode managedError = json(mockMvc.perform(authed(
                        get("/api/v1/chats/{id}/keys", managedChat), aliceToken, aliceDevice))
                .andExpect(status().isConflict()).andReturn());
        assertThat(managedError.get("code").asText()).isEqualTo("MODE_NOT_SUPPORTED");
    }

    @Test
    void flagOffBlocksE2eeWorkspaceChatAndMessagesAndManagedShapesStayContractual()
            throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        register(bob, "flag-bob-keyed", DeviceKeyTestSupport.generate());

        // E2EE workspace creation is gated by the flag before any write.
        JsonNode workspaceError = expectError(post("/api/v1/workspaces"), alice,
                Map.of("name", "E2EE " + UUID.randomUUID(), "security_mode", "E2EE"), 409);
        assertThat(workspaceError.get("code").asText()).isEqualTo("E2EE_DISABLED");

        UUID managedDirect = createDirect(alice, bob);
        JsonNode list = chatList(alice);
        CONTRACT.assertValid("ChatList", list);
        JsonNode direct = findById(list.get("items"), managedDirect);
        assertThat(direct.get("name").isNull()).isTrue();
        assertThat(direct.get("peer_id").asText()).isEqualTo(bob.user().id().toString());
        assertThat(direct.get("peer_has_e2ee_capable_devices").asBoolean()).isTrue();
        JsonNode group = findById(list.get("items"), alice.chat().id());
        assertThat(group.get("peer_id").isNull()).isTrue();
        assertThat(group.get("peer_has_e2ee_capable_devices").asBoolean()).isFalse();

        // Managed message: 201 MessageCreateResult without coverage; client_message_id echoed.
        String clientId = UUID.randomUUID().toString();
        MvcResult sent = mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", managedDirect), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "client_message_id", clientId,
                                "type", "TEXT",
                                "text", "managed"))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode message = json(sent);
        CONTRACT.assertValid("MessageCreateResult", message);
        assertThat(message.get("client_message_id").asText()).isEqualTo(clientId);
        assertThat(message.get("crypto").isNull()).isTrue();
        assertThat(message.has("envelope_coverage")).isFalse();

        // E2EE chat fixture (GROUP, so the managed DIRECT pair stays unique): messages are
        // disabled (flag off), never a plaintext fallback.
        UUID e2eeChat = createE2eeGroup(alice, bob);
        JsonNode sendError = json(mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", e2eeChat), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "client_message_id", UUID.randomUUID().toString(),
                                "type", "TEXT", "text", "must-not-be-stored"))))
                .andExpect(status().isConflict()).andReturn());
        assertThat(sendError.get("code").asText()).isEqualTo("E2EE_DISABLED");
        JsonNode readError = json(mockMvc.perform(authed(
                        get("/api/v1/chats/{id}/messages", e2eeChat), alice))
                .andExpect(status().isConflict()).andReturn());
        assertThat(readError.get("code").asText()).isEqualTo("E2EE_DISABLED");
        assertThat(messageCount(e2eeChat)).isZero();

        // Managed chat with envelopes is still an E2EE operation -> 409 E2EE_DISABLED.
        Map<String, Object> withEnvelope = new LinkedHashMap<>();
        withEnvelope.put("client_message_id", UUID.randomUUID().toString());
        withEnvelope.put("type", "TEXT");
        withEnvelope.put("envelopes", List.of(Map.of("v", 1)));
        JsonNode envelopeError = json(mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", managedDirect), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(withEnvelope)))
                .andExpect(status().isConflict()).andReturn());
        assertThat(envelopeError.get("code").asText()).isEqualTo("E2EE_DISABLED");
    }

    @Test
    void concurrentPrekeyUploadsCannotExceedTheCap() throws Exception {
        SessionResponse alice = devSession();
        Material material = DeviceKeyTestSupport.generate();
        UUID deviceId = UUID.fromString(register(alice, "cap-" + UUID.randomUUID(), material)
                .get("id").asText());
        String token = tokenFor(alice, deviceId);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<MvcResult>> futures = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                Map<String, Object> body = material.prekeyUploadBody(150,
                        "spk-cap-" + UUID.randomUUID());
                futures.add(pool.submit(() -> {
                    start.await(5, TimeUnit.SECONDS);
                    return mockMvc.perform(authed(
                                    post("/api/v1/devices/{id}/prekeys", deviceId), token,
                                    deviceId)
                                    .header("Idempotency-Key", UUID.randomUUID())
                                    .contentType(MediaType.APPLICATION_JSON)
                                    .content(objectMapper.writeValueAsString(body)))
                            .andReturn();
                }));
            }
            start.countDown();
            int accepted = 0;
            int rejected = 0;
            for (Future<MvcResult> future : futures) {
                MvcResult result = future.get(20, TimeUnit.SECONDS);
                if (result.getResponse().getStatus() == 200) {
                    accepted++;
                } else {
                    assertThat(result.getResponse().getStatus()).isEqualTo(422);
                    assertThat(json(result).get("code").asText())
                            .isEqualTo("PREKEY_LIMIT_EXCEEDED");
                    rejected++;
                }
            }
            assertThat(accepted).isEqualTo(1);
            assertThat(rejected).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }

        Integer available = migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys
                 WHERE device_id = ? AND kind = 'ONE_TIME' AND consumed_at IS NULL
                   AND expires_at > now()
                """, Integer.class, deviceId);
        assertThat(available).isLessThanOrEqualTo(200);
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

    private String tokenFor(SessionResponse session, UUID deviceId) {
        return tokenIssuer.issue(session.user().id(), deviceId, session.workspace().id())
                .accessToken();
    }

    private MockHttpServletRequestBuilder authed(MockHttpServletRequestBuilder builder,
                                                 String token, UUID deviceId) {
        return builder.header("Authorization", "Bearer " + token)
                .header("X-Device-Id", deviceId.toString());
    }

    private JsonNode uploadPrekeys(String token, UUID deviceId, Map<String, Object> body,
                                   int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/devices/{id}/prekeys", deviceId), token, deviceId)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private JsonNode claim(String token, UUID deviceId, UUID chatId, UUID userId,
                           UUID targetDeviceId, int expected) throws Exception {
        Map<String, Object> body = Map.of("chat_id", chatId.toString(),
                "devices", List.of(Map.of("device_id", targetDeviceId.toString(),
                        "user_id", userId.toString())));
        MvcResult result = mockMvc.perform(authed(post("/api/v1/keys/claim"), token, deviceId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private Map<String, Object> verificationBody(UUID targetDeviceId, int vhVersion) {
        return Map.of("device_id", targetDeviceId.toString(),
                "method", "MANUAL",
                "vh_version", vhVersion,
                "safety_number_hash",
                ru.krug.backend.shared.application.model.Base64Url.encode(new byte[32]));
    }

    private JsonNode putVerification(String token, UUID deviceId, UUID chatId,
                                     Map<String, Object> body, int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        put("/api/v1/chats/{id}/keys/verification", chatId), token, deviceId)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private JsonNode expectError(MockHttpServletRequestBuilder request, SessionResponse session,
                                 Object body, int expected) throws Exception {
        return expectError(request, session.accessToken(), session.device().id(), body, expected);
    }

    private JsonNode expectError(MockHttpServletRequestBuilder request, String token,
                                 UUID deviceId, Object body, int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(request, token, deviceId)
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

    private UUID createDirect(SessionResponse alice, SessionResponse bob) throws Exception {
        return createDirect(alice, bob, null);
    }

    private UUID createDirect(SessionResponse alice, SessionResponse bob, String mode)
            throws Exception {
        if (mode == null) {
            MvcResult result = mockMvc.perform(authed(
                            post("/api/v1/workspaces/{id}/chats", alice.workspace().id()), alice)
                            .header("Idempotency-Key", UUID.randomUUID())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of(
                                    "type", "DIRECT",
                                    "peer_id", bob.user().id().toString()))))
                    .andExpect(status().isCreated())
                    .andReturn();
            JsonNode chat = json(result);
            CONTRACT.assertValid("Chat", chat);
            return UUID.fromString(chat.get("id").asText());
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
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chatId, alice.workspace().id());
        return chatId;
    }

    private UUID createE2eeGroup(SessionResponse alice, SessionResponse bob) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'E2EE', 'E2EE fixture', ?)
                """, chatId, alice.workspace().id(), alice.user().id());
        for (SessionResponse member : List.of(alice, bob)) {
            migrator().update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'ACTIVE')
                    """, chatId, alice.workspace().id(), member.user().id(),
                    member == alice ? "OWNER" : "MEMBER");
        }
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chatId, alice.workspace().id());
        return chatId;
    }

    private static JsonNode findById(JsonNode items, UUID id) {
        for (JsonNode item : items) {
            if (id.toString().equals(item.get("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("id not found: " + id + " in " + items);
    }

    private static JsonNode findByDeviceId(JsonNode items, UUID id) {
        for (JsonNode item : items) {
            if (id.toString().equals(item.get("device_id").asText())) {
                return item;
            }
        }
        throw new AssertionError("device not found: " + id);
    }
}
