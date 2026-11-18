package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.WebSocketIntegrationTestBase;
import ru.krug.backend.support.WsFrameContract;
import ru.krug.backend.support.WsTestClient;

/**
 * E7-B1F P1-03 realtime coverage: revoke/verification/prekey/device-add publish
 * {@code chat.keys.changed} and {@code device.list.changed} after commit (metadata only, no
 * {@code seq}, not replayed), and a revoked device is closed proactively with
 * {@code session.revoked} + 4403 instead of being discovered lazily.
 */
@ActiveProfiles("test")
class E2eeRealtimeIT extends WebSocketIntegrationTestBase {

    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void revokeNotifiesOwnerAndChatsClosesTheDeviceAndDoesNotRepeat() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        UUID aliceDevice = registerDevice(alice, "rt-alice",
                DeviceKeyTestSupport.generate());
        UUID bobFirst = registerDevice(bob, "rt-bob-1", DeviceKeyTestSupport.generate());
        UUID bobSecond = registerDevice(bob, "rt-bob-2", DeviceKeyTestSupport.generate());
        UUID chatId = createE2eeDirect(alice, bob);

        SessionResponse aliceSession = withDevice(alice, aliceDevice);
        // Bob's session must carry the chat's workspace, not his own dev workspace.
        SessionResponse bobFirstSession = withDevice(bob, bobFirst, alice.workspace().id());
        SessionResponse bobSecondSession = withDevice(bob, bobSecond, alice.workspace().id());

        WsTestClient aliceWs = connect(aliceSession);
        WsTestClient bobFirstWs = connect(bobFirstSession);
        WsTestClient bobSecondWs = connect(bobSecondSession);
        subscribe(aliceWs, chatId);
        subscribe(bobFirstWs, chatId);
        subscribe(bobSecondWs, chatId);

        assertThat(delete("/api/v1/devices/" + bobSecond, bobFirstSession)
                .getStatusCode().value()).isEqualTo(204);

        JsonNode listChanged = bobFirstWs.awaitEventWhere("device.list.changed", "device_id",
                bobSecond.toString(), TIMEOUT);
        WsFrameContract.assertValid("deviceListChanged", listChanged.toString());
        assertThat(listChanged.get("payload").get("status").asText()).isEqualTo("REVOKED");
        assertThat(listChanged.get("payload").get("key_generation").asInt()).isEqualTo(2);
        assertThat(listChanged.has("seq")).isFalse();
        assertThat(listChanged.has("event_id")).isFalse();

        JsonNode ownerEvent = bobFirstWs.awaitEventWhere("chat.keys.changed", "device_id",
                bobSecond.toString(), TIMEOUT);
        WsFrameContract.assertValid("keyChanged", ownerEvent.toString());
        assertKeysChanged(ownerEvent, chatId, "DEVICE_REVOKED", bobSecond, 2);
        JsonNode peerEvent = aliceWs.awaitEventWhere("chat.keys.changed", "device_id",
                bobSecond.toString(), TIMEOUT);
        assertKeysChanged(peerEvent, chatId, "DEVICE_REVOKED", bobSecond, 2);

        JsonNode revoked = bobSecondWs.awaitType("session.revoked", TIMEOUT);
        assertThat(revoked.get("reason").asText()).isEqualTo("DEVICE_REVOKED");
        assertThat(bobSecondWs.awaitClose(TIMEOUT).get("close_code").asInt()).isEqualTo(4403);

        // The revoked device is gone from the chat key list for the peer.
        JsonNode keys = getJson("/api/v1/chats/" + chatId + "/keys", aliceSession);
        for (JsonNode device : keys.get("devices")) {
            assertThat(device.get("device_id").asText()).isNotEqualTo(bobSecond.toString());
        }
        // Alice's device + Bob's remaining capable device; the revoked one is excluded.
        assertThat(keys.get("devices_total").asInt()).isEqualTo(2);

        // A repeated revoke is a 204 and emits no duplicate event.
        assertThat(delete("/api/v1/devices/" + bobSecond, bobFirstSession)
                .getStatusCode().value()).isEqualTo(204);
        assertThat(bobFirstWs.awaitEventWithin("chat.keys.changed", Duration.ofMillis(500)))
                .isNull();
        assertThat(aliceWs.awaitEventWithin("chat.keys.changed", Duration.ofMillis(500)))
                .isNull();

        // Key events are not replayed: a fresh subscribe only replays messages.
        WsTestClient reconnect = connect(aliceSession);
        subscribe(reconnect, chatId);
        assertThat(reconnect.awaitEventWithin("chat.keys.changed", Duration.ofMillis(400)))
                .isNull();
        reconnect.close();
        aliceWs.close();
        bobFirstWs.close();
    }

    @Test
    void verificationPrekeyAndDeviceAddPublishKeyEvents() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        UUID aliceDevice = registerDevice(alice, "rt2-alice",
                DeviceKeyTestSupport.generate());
        Material bobKeys = DeviceKeyTestSupport.generate();
        UUID bobDevice = registerDevice(bob, "rt2-bob", bobKeys);
        UUID chatId = createE2eeDirect(alice, bob);
        SessionResponse aliceSession = withDevice(alice, aliceDevice);
        SessionResponse bobSession = withDevice(bob, bobDevice, alice.workspace().id());

        WsTestClient bobWs = connect(bobSession);
        subscribe(bobWs, chatId);

        // Verification -> VERIFICATION_CHANGED in the chat.
        Map<String, Object> verification = new LinkedHashMap<>();
        verification.put("device_id", bobDevice.toString());
        verification.put("method", "MANUAL");
        verification.put("vh_version", 2);
        verification.put("safety_number_hash", Base64Url.encode(new byte[32]));
        verification.put("expected_key_generation", 1);
        ResponseEntity<String> verify = putJson(
                "/api/v1/chats/" + chatId + "/keys/verification", aliceSession,
                verification);
        assertThat(verify.getStatusCode().value()).isEqualTo(201);
        JsonNode verifiedEvent = bobWs.awaitEventWhere("chat.keys.changed", "reason",
                "VERIFICATION_CHANGED", TIMEOUT);
        assertKeysChanged(verifiedEvent, chatId, "VERIFICATION_CHANGED", bobDevice, 1);

        // Prekey rotation -> device.list.changed + chat.keys.changed (re-read bucket).
        Map<String, Object> upload = bobKeys.prekeyUploadBody(1,
                "rt-spk-" + UUID.randomUUID());
        ResponseEntity<String> uploaded = postJson(
                "/api/v1/devices/" + bobDevice + "/prekeys", bobSession, upload);
        assertThat(uploaded.getStatusCode().value()).isEqualTo(200);
        JsonNode prekeyList = bobWs.awaitEventWhere("device.list.changed", "device_id",
                bobDevice.toString(), TIMEOUT);
        assertThat(prekeyList.get("payload").get("status").asText()).isEqualTo("ACTIVE");
        JsonNode prekeyChat = bobWs.awaitEventWhere("chat.keys.changed", "reason",
                "KEY_GENERATION_CHANGED", TIMEOUT);
        assertThat(prekeyChat.get("payload").get("device_id").asText())
                .isEqualTo(bobDevice.toString());

        // A new capable device -> DEVICE_ADDED in the chat and the owner's device list.
        UUID newDevice = registerDevice(bob, "rt2-bob-2", DeviceKeyTestSupport.generate());
        JsonNode addedList = bobWs.awaitEventWhere("device.list.changed", "device_id",
                newDevice.toString(), TIMEOUT);
        assertThat(addedList.get("payload").get("status").asText()).isEqualTo("ACTIVE");
        JsonNode addedChat = bobWs.awaitEventWhere("chat.keys.changed", "reason",
                "DEVICE_ADDED", TIMEOUT);
        assertThat(addedChat.get("payload").get("device_id").asText())
                .isEqualTo(newDevice.toString());
        bobWs.close();
    }

    // ---------------------------------------------------------------------

    private void assertKeysChanged(JsonNode frame, UUID chatId, String reason, UUID deviceId,
                                   int generation) {
        assertThat(frame.get("event").asText()).isEqualTo("chat.keys.changed");
        assertThat(frame.has("seq")).isFalse();
        assertThat(frame.has("event_id")).isFalse();
        JsonNode payload = frame.get("payload");
        assertThat(payload.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(payload.get("reason").asText()).isEqualTo(reason);
        assertThat(payload.get("device_id").asText()).isEqualTo(deviceId.toString());
        assertThat(payload.get("key_generation").asInt()).isEqualTo(generation);
    }

    private WsTestClient connect(SessionResponse session) throws Exception {
        String ticket = ticket(session).get("ticket").asText();
        WsTestClient client = WsTestClient.connect(objectMapper, port, ticket,
                "http://localhost:5173");
        client.awaitType("hello", TIMEOUT);
        return client;
    }

    private void subscribe(WsTestClient client, UUID chatId) {
        client.send("{\"v\":1,\"type\":\"subscribe\",\"chats\":[{\"chat_id\":\""
                + chatId + "\",\"last_seq\":0}],\"presence\":false}");
        JsonNode subscribed = client.awaitType("subscribed", TIMEOUT);
        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean())
                .as(subscribed.toString()).isTrue();
    }

    private SessionResponse withDevice(SessionResponse session, UUID deviceId) {
        return withDevice(session, deviceId, session.workspace().id());
    }

    private SessionResponse withDevice(SessionResponse session, UUID deviceId,
                                       UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), deviceId, workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                new SessionResponse.DeviceInfo(deviceId, "WEB"), session.workspace(),
                session.chat());
    }

    private UUID registerDevice(SessionResponse session, String name, Material material)
            throws Exception {
        ResponseEntity<String> response = postJson("/api/v1/devices", session,
                material.registrationBody(name, "0.7.0"));
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("register failed: " + response.getStatusCode()
                    + " " + response.getBody());
        }
        return UUID.fromString(json(response.getBody()).get("id").asText());
    }

    private ResponseEntity<String> postJson(String path, SessionResponse session, Object body)
            throws Exception {
        return exchange(HttpMethod.POST, path, session, body);
    }

    private ResponseEntity<String> putJson(String path, SessionResponse session, Object body)
            throws Exception {
        return exchange(HttpMethod.PUT, path, session, body);
    }

    private ResponseEntity<String> exchange(HttpMethod method, String path,
                                            SessionResponse session, Object body)
            throws Exception {
        HttpHeaders headers = authHeaders(session);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        return rest.exchange(url(path), method,
                new HttpEntity<>(objectMapper.writeValueAsString(body), headers), String.class);
    }

    private ResponseEntity<String> delete(String path, SessionResponse session) {
        HttpHeaders headers = authHeaders(session);
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        return rest.exchange(url(path), HttpMethod.DELETE, new HttpEntity<>(headers),
                String.class);
    }

    private JsonNode getJson(String path, SessionResponse session) throws Exception {
        ResponseEntity<String> response = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(authHeaders(session)), String.class);
        if (response.getStatusCode().value() != 200) {
            throw new IllegalStateException("GET " + path + " failed: "
                    + response.getStatusCode() + " " + response.getBody());
        }
        return json(response.getBody());
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
