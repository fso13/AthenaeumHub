package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.WebSocketIntegrationTestBase;
import ru.krug.backend.support.WsTestClient;

/**
 * E7-B4 realtime: {@code message.created} for an E2EE message carries no plaintext and only
 * the envelope of the connection's device; live fan-out and replay build the frame per
 * device, so another device of the same user never receives a foreign envelope.
 */
@ActiveProfiles("test")
@TestPropertySource(properties = "krug.e2ee.enabled=true")
class E2eeMessageRealtimeIT extends WebSocketIntegrationTestBase {

    private static final Duration TIMEOUT = Duration.ofSeconds(8);
    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @MockBean
    private E2eeSettingsPort e2eeSettings;

    @BeforeEach
    void enableE2ee() {
        org.mockito.BDDMockito.given(e2eeSettings.enabled()).willReturn(true);
    }

    @Test
    void e2eeMessageCreatedIsPerDeviceAndReplayCarriesTheDeviceEnvelope() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());

        Device a1 = registerDevice(alice, "rt-a1");
        Device a2 = registerDevice(alice, "rt-a2");
        Device b1 = registerDevice(bob, "rt-b1");

        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);
        SessionResponse bobSession = withDevice(bob, b1.id(), workspaceId);

        WsTestClient bobWs = connect(bobSession);
        subscribe(bobWs, chatId);
        WsTestClient aliceWs = connect(aliceSession);
        subscribe(aliceWs, chatId);

        byte[] toBob = random(300);
        byte[] toA2 = random(300);
        UUID clientMessageId = UUID.randomUUID();
        JsonNode sent = send(aliceSession, a1.id(), chatId, e2eeBody(clientMessageId, List.of(
                envelope(chatId, a1, b1, toBob, true),
                envelope(chatId, a1, a2, toA2, false))));
        assertThat(sent.get("envelope_coverage")).isNotNull();
        assertThat(sent.get("text").isNull()).isTrue();

        JsonNode bobEvent = bobWs.awaitEvent("message.created", TIMEOUT);
        JsonNode bobPayload = bobEvent.get("payload");
        assertThat(bobEvent.get("seq").asLong()).isEqualTo(1);
        assertThat(bobPayload.get("text").isNull()).isTrue();
        assertThat(bobPayload.get("client_message_id").asText())
                .isEqualTo(clientMessageId.toString());
        JsonNode bobCrypto = bobPayload.get("crypto");
        CONTRACT.assertValid("CryptoEnvelope", bobCrypto);
        assertThat(bobCrypto.get("recipient_device_id").asText())
                .isEqualTo(b1.id().toString());
        assertThat(Base64Url.decode(bobCrypto.get("ciphertext").asText()).orElseThrow())
                .isEqualTo(toBob);

        // The sender's own device has no self-envelope: crypto:null, no plaintext.
        JsonNode aliceEvent = aliceWs.awaitEvent("message.created", TIMEOUT);
        JsonNode alicePayload = aliceEvent.get("payload");
        assertThat(alicePayload.get("crypto").isNull()).isTrue();
        assertThat(alicePayload.get("text").isNull()).isTrue();
        assertThat(alicePayload.get("client_message_id").asText())
                .isEqualTo(clientMessageId.toString());
        // The other device's envelope never leaks into the sender's frame.
        assertThat(aliceEvent.toString()).doesNotContain(a2.id().toString())
                .doesNotContain(b1.id().toString());

        bobWs.close();
        aliceWs.close();

        // Replay after reconnect: the history adapter resolves the envelope for this device.
        WsTestClient replayed = connect(bobSession);
        subscribe(replayed, chatId, 0);
        JsonNode replay = replayed.awaitEvent("message.created", TIMEOUT);
        assertThat(replay.get("seq").asLong()).isEqualTo(1);
        assertThat(replay.get("payload").get("text").isNull()).isTrue();
        assertThat(replay.get("payload").get("crypto").get("recipient_device_id").asText())
                .isEqualTo(b1.id().toString());
        replayed.close();

        // A third device that has no envelope sees crypto:null on replay.
        SessionResponse a3Session = withDevice(alice, registerDevice(alice, "rt-a3").id(),
                workspaceId);
        WsTestClient withoutEnvelope = connect(a3Session);
        subscribe(withoutEnvelope, chatId, 0);
        JsonNode noCrypto = withoutEnvelope.awaitEvent("message.created", TIMEOUT);
        assertThat(noCrypto.get("payload").get("text").isNull()).isTrue();
        assertThat(noCrypto.get("payload").get("crypto").isNull()).isTrue();
        withoutEnvelope.close();
    }

    @Test
    void flagOffGatesIdempotencyReplayAndWsReplay() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "flag-a1");
        Device b1 = registerDevice(bob, "flag-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);
        SessionResponse bobSession = withDevice(bob, b1.id(), workspaceId);

        // Managed replay must keep working across the kill-switch.
        UUID managedChat = alice.chat().id();
        UUID managedClientId = UUID.randomUUID();
        UUID managedKey = UUID.randomUUID();
        String managedBody = objectMapper.writeValueAsString(Map.of(
                "client_message_id", managedClientId.toString(), "type", "TEXT",
                "text", "managed"));
        assertThat(postMessage(alice.accessToken(), alice.device().id(), managedChat,
                managedBody, managedKey).getStatusCode().value()).isEqualTo(201);

        // Store an E2EE message while the flag is on.
        Map<String, Object> e2eeBody = e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, b1, random(272), true)));
        UUID e2eeKey = UUID.randomUUID();
        assertThat(postMessage(aliceSession.accessToken(), a1.id(), chatId,
                objectMapper.writeValueAsString(e2eeBody), e2eeKey).getStatusCode().value())
                .isEqualTo(201);

        org.mockito.BDDMockito.given(e2eeSettings.enabled()).willReturn(false);

        // Idempotency-Key replay of a stored E2EE message is gated by the flag.
        ResponseEntity<String> replay = postMessage(aliceSession.accessToken(), a1.id(), chatId,
                objectMapper.writeValueAsString(e2eeBody), e2eeKey);
        assertThat(replay.getStatusCode().value()).isEqualTo(409);
        assertThat(json(replay.getBody()).get("code").asText()).isEqualTo("E2EE_DISABLED");

        // REST read is gated too.
        ResponseEntity<String> read = rest.exchange(
                url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.GET,
                new HttpEntity<>(headers(aliceSession.accessToken(), a1.id())), String.class);
        assertThat(read.getStatusCode().value()).isEqualTo(409);
        assertThat(json(read.getBody()).get("code").asText()).isEqualTo("E2EE_DISABLED");

        // WS replay never publishes the stored E2EE message/envelope with the flag off.
        WsTestClient disabledWs = connect(bobSession);
        subscribe(disabledWs, chatId, 0);
        assertThat(disabledWs.awaitEventWithin("message.created", Duration.ofSeconds(2)))
                .as("no E2EE message.created may be replayed while the flag is off")
                .isNull();
        disabledWs.close();

        // Managed idempotent replay is unaffected (flag off).
        ResponseEntity<String> managedReplay = postMessage(alice.accessToken(),
                alice.device().id(), managedChat, managedBody, managedKey);
        assertThat(managedReplay.getStatusCode().value()).isEqualTo(201);
        assertThat(managedReplay.getHeaders().getFirst("Idempotent-Replay")).isEqualTo("true");
    }

    private ResponseEntity<String> postMessage(String token, UUID deviceId, UUID chatId,
                                               String body, UUID idempotencyKey) {
        HttpHeaders headers = headers(token, deviceId);
        headers.add("Idempotency-Key", idempotencyKey.toString());
        return rest.exchange(url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.POST,
                new HttpEntity<>(body, headers), String.class);
    }

    @Test
    void encodedPathsCannotBypassDeviceBindingOrPayloadLimit() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "path-a1");
        Device a2 = registerDevice(alice, "path-a2");
        Device b1 = registerDevice(bob, "path-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);

        // One stored E2EE message addressed to B1; A1 (sender) has no envelope.
        send(aliceSession, a1.id(), chatId, e2eeBody(UUID.randomUUID(), List.of(
                envelope(chatId, a1, b1, random(272), true))));

        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        String base = "http://localhost:" + port;
        String canonical = base + "/api/v1/chats/" + chatId + "/messages";
        String encoded = base + "/api/v1/%63hats/" + chatId + "/%6Dessages";

        // P0-01: canonical and encoded forms must both reject a foreign X-Device-Id.
        assertThat(get(client, canonical, aliceSession.accessToken(), b1.id()).statusCode())
                .isEqualTo(401);
        assertThat(get(client, encoded, aliceSession.accessToken(), b1.id()).statusCode())
                .isEqualTo(401);

        // Another owned device is allowed but never receives B1's envelope. Its token is
        // bound to A2 (dev binding requires the header to match the signed claim).
        SessionResponse a2Session = withDevice(alice, a2.id(), workspaceId);
        HttpResponse<String> ownDevice = get(client, encoded, a2Session.accessToken(),
                a2.id());
        assertThat(ownDevice.statusCode()).isEqualTo(200);
        JsonNode ownPage = json(ownDevice.body());
        CONTRACT.assertValid("MessagePage", ownPage);
        assertThat(ownPage.get("items").get(0).get("crypto").isNull()).isTrue();

        // The same bypass on GET /chats/{id}/keys is rejected too.
        assertThat(get(client, base + "/api/v1/%63hats/" + chatId + "/keys",
                aliceSession.accessToken(), b1.id()).statusCode()).isEqualTo(401);

        // P1-01: >512 KiB body is rejected on canonical and encoded routes.
        String huge = "{\"client_message_id\":\"" + UUID.randomUUID()
                + "\",\"type\":\"TEXT\",\"envelopes\":[],\"pad\":\""
                + "x".repeat(600_000) + "\"}";
        assertThat(post(client, canonical, aliceSession.accessToken(), a1.id(), huge)
                .statusCode()).isEqualTo(413);
        assertThat(post(client, encoded, aliceSession.accessToken(), a1.id(), huge)
                .statusCode()).isEqualTo(413);
        assertThat(post(client, base + "/api/v1/chats/" + chatId + "/%6Dessages",
                aliceSession.accessToken(), a1.id(), huge).statusCode()).isEqualTo(413);

        // Neither bypass created a second message.
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM message.messages WHERE chat_id = ?", Integer.class,
                chatId)).isEqualTo(1);
    }

    /**
     * E7-B3F3 P2-12: permanent real-HTTP regressions for the envelope floor, the 512 KiB
     * wire limit (including chunked bodies without Content-Length) and encoded/malformed
     * paths. None of these may answer 500 or bypass the device binding.
     */
    @Test
    void wireFloorChunkedAndEncodedPathRegressionsArePermanent() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "wire-a1");
        Device b1 = registerDevice(bob, "wire-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);

        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        String base = "http://localhost:" + port;
        String canonical = base + "/api/v1/chats/" + chatId + "/messages";
        String encoded = base + "/api/v1/%63hats/" + chatId + "/%6Dessages";

        // --- Envelope floor over real HTTP (decoded bytes, encoded 363..44054 chars) ---
        HttpResponse<String> tooShort = post(client, canonical, aliceSession.accessToken(),
                a1.id(), e2eeBodyJson(chatId, a1, b1, random(271)));
        assertThat(tooShort.statusCode()).isEqualTo(422);
        JsonNode tooShortError = json(tooShort.body());
        assertThat(tooShortError.get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");
        assertThat(tooShortError.get("details").get("reason").asText())
                .isEqualTo("ciphertext_too_short");

        HttpResponse<String> atFloor = post(client, canonical, aliceSession.accessToken(),
                a1.id(), e2eeBodyJson(chatId, a1, b1, random(272)));
        assertThat(atFloor.statusCode()).isEqualTo(201);
        UUID floorId = UUID.fromString(json(atFloor.body()).get("id").asText());
        assertThat(storedCiphertextLength(floorId, b1.id())).isEqualTo(272);

        HttpResponse<String> atCap = post(client, canonical, aliceSession.accessToken(),
                a1.id(), e2eeBodyJson(chatId, a1, b1, random(33040)));
        assertThat(atCap.statusCode()).isEqualTo(201);
        UUID capId = UUID.fromString(json(atCap.body()).get("id").asText());
        assertThat(storedCiphertextLength(capId, b1.id())).isEqualTo(33040);

        HttpResponse<String> overCap = post(client, canonical, aliceSession.accessToken(),
                a1.id(), e2eeBodyJson(chatId, a1, b1, random(33041)));
        assertThat(overCap.statusCode()).isEqualTo(413);
        JsonNode overCapError = json(overCap.body());
        assertThat(overCapError.get("code").asText()).isEqualTo("ENVELOPE_TOO_LARGE");
        assertThat(overCapError.get("details").get("reason").asText()).isEqualTo("canonical");

        // --- Encoded paths: same route for canonical and single-encoded forms ---
        assertThat(get(client, canonical, aliceSession.accessToken(), a1.id()).statusCode())
                .isEqualTo(200);
        assertThat(get(client, encoded, aliceSession.accessToken(), a1.id()).statusCode())
                .isEqualTo(200);
        assertThat(get(client, base + "/api/v1/%63hats/" + chatId + "/%6dessages",
                aliceSession.accessToken(), a1.id()).statusCode()).isEqualTo(200);
        assertThat(get(client, canonical + "?limit=1", aliceSession.accessToken(),
                a1.id()).statusCode()).isEqualTo(200);

        // A nested percent-encoding would be decoded a second time by the dispatcher; the
        // container/firewall rejects it before that split-brain (P0-01 class). Both 400
        // (container) and 404 (our path guard) are acceptable rejections; 200 is not.
        assertThat(get(client, base + "/api/v1/%2563hats/" + chatId + "/messages",
                aliceSession.accessToken(), a1.id()).statusCode()).isIn(400, 404);
        for (String malformed : List.of(canonical + ";x=1", canonical + "/..",
                canonical + "/", base + "/api/v1//chats/" + chatId + "/messages")) {
            // Matrix params, traversal, empty segments -> our path guard (404); the
            // container firewall may reject a raw ';' earlier (400). Both are rejections.
            assertThat(get(client, malformed, aliceSession.accessToken(), a1.id()).statusCode())
                    .as(malformed).isIn(400, 404);
        }

        // Sending through the encoded route still works and is device-bound.
        HttpResponse<String> encodedSend = post(client, encoded, aliceSession.accessToken(),
                a1.id(), e2eeBodyJson(chatId, a1, b1, random(272)));
        assertThat(encodedSend.statusCode()).isEqualTo(201);

        // --- 512 KiB wire limit, chunked (no Content-Length) over the real connector ---
        UUID managedChat = alice.chat().id();
        ChunkedResponse exact = postChunked(
                base + "/api/v1/chats/" + managedChat + "/messages",
                alice.accessToken(), alice.device().id(), paddedBudgetBody(524288));
        assertThat(exact.status()).as(exact.body()).isEqualTo(201);
        ChunkedResponse over = postChunked(
                base + "/api/v1/chats/" + managedChat + "/messages",
                alice.accessToken(), alice.device().id(), paddedBudgetBody(524289));
        assertThat(over.status()).isEqualTo(413);
        assertThat(json(over.body()).get("code").asText()).isEqualTo("PAYLOAD_TOO_LARGE");

        // Exactly the two accepted floor/cap messages plus the encoded-route message exist;
        // the rejected 271/33041 bodies never created rows.
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM message.messages WHERE chat_id = ?", Integer.class,
                chatId)).isEqualTo(3);
    }

    private String e2eeBodyJson(UUID chatId, Device sender, Device recipient, byte[] ciphertext)
            throws Exception {
        return objectMapper.writeValueAsString(e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, sender, recipient, ciphertext, true))));
    }

    private int storedCiphertextLength(UUID messageId, UUID deviceId) {
        Integer length = migrator().queryForObject("""
                SELECT octet_length(ciphertext) FROM message.message_envelopes
                 WHERE message_id = ? AND recipient_device_id = ?
                """, Integer.class, messageId, deviceId);
        return length == null ? -1 : length;
    }

    private String paddedBudgetBody(int bytes) {
        String prefix = "{\"client_message_id\":\"" + UUID.randomUUID()
                + "\",\"type\":\"TEXT\",\"text\":\"ok\"}";
        return prefix + " ".repeat(bytes - prefix.length());
    }

    private ChunkedResponse postChunked(String url, String token, UUID deviceId, String body)
            throws Exception {
        HttpURLConnection connection =
                (HttpURLConnection) URI.create(url).toURL().openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setChunkedStreamingMode(8192);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("X-Device-Id", deviceId.toString());
        connection.setRequestProperty("Idempotency-Key", UUID.randomUUID().toString());
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400
                ? connection.getErrorStream() : connection.getInputStream();
        String response = stream == null ? ""
                : new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        connection.disconnect();
        return new ChunkedResponse(status, response);
    }

    private record ChunkedResponse(int status, String body) {
    }

    private HttpResponse<String> get(HttpClient client, String url, String token,
                                     UUID deviceId) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .header("Authorization", "Bearer " + token)
                .header("X-Device-Id", deviceId.toString())
                .GET()
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(HttpClient client, String url, String token,
                                      UUID deviceId, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .header("Authorization", "Bearer " + token)
                .header("X-Device-Id", deviceId.toString())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    // ---------------------------------------------------------------------

    private record Device(UUID id, Material material) {
    }

    private WsTestClient connect(SessionResponse session) throws Exception {
        String ticket = ticket(session).get("ticket").asText();
        WsTestClient client = WsTestClient.connect(objectMapper, port, ticket,
                "http://localhost:5173");
        client.awaitType("hello", TIMEOUT);
        return client;
    }

    private void subscribe(WsTestClient client, UUID chatId) {
        subscribe(client, chatId, 0);
    }

    private void subscribe(WsTestClient client, UUID chatId, long lastSeq) {
        client.send("{\"v\":1,\"type\":\"subscribe\",\"chats\":[{\"chat_id\":\""
                + chatId + "\",\"last_seq\":" + lastSeq + "}],\"presence\":false}");
        JsonNode subscribed = client.awaitType("subscribed", TIMEOUT);
        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean())
                .as(subscribed.toString()).isTrue();
    }

    private SessionResponse withDevice(SessionResponse session, UUID deviceId,
                                       UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), deviceId, workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                new SessionResponse.DeviceInfo(deviceId, "WEB"), session.workspace(),
                session.chat());
    }

    private HttpHeaders headers(String token, UUID deviceId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.add("X-Device-Id", deviceId.toString());
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private UUID createE2eeWorkspace(SessionResponse owner) throws Exception {
        ResponseEntity<String> response = rest.exchange(url("/api/v1/workspaces"),
                HttpMethod.POST, new HttpEntity<>(objectMapper.writeValueAsString(Map.of(
                        "name", "e2ee-rt-" + UUID.randomUUID(), "security_mode", "E2EE")),
                        withIdempotency(headers(owner.accessToken(),
                                owner.device().id()))), String.class);
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("workspace create failed: "
                    + response.getStatusCode() + " " + response.getBody());
        }
        return UUID.fromString(json(response.getBody()).get("id").asText());
    }

    private void joinWorkspace(UUID workspaceId, UUID userId) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, workspaceId, userId);
    }

    private Device registerDevice(SessionResponse session, String name) throws Exception {
        Material material = DeviceKeyTestSupport.generate();
        HttpHeaders headers = withIdempotency(headers(session.accessToken(),
                session.device().id()));
        ResponseEntity<String> response = rest.exchange(url("/api/v1/devices"),
                HttpMethod.POST, new HttpEntity<>(objectMapper.writeValueAsString(
                        material.registrationBody(name + "-" + UUID.randomUUID(), "0.7.0")),
                        headers), String.class);
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("device register failed: "
                    + response.getStatusCode() + " " + response.getBody());
        }
        return new Device(UUID.fromString(json(response.getBody()).get("id").asText()),
                material);
    }

    private UUID createDirect(SessionResponse alice, UUID workspaceId, UUID peerId)
            throws Exception {
        HttpHeaders headers = withIdempotency(headers(alice.accessToken(),
                alice.device().id()));
        ResponseEntity<String> response = rest.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/chats"), HttpMethod.POST,
                new HttpEntity<>(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                        "peer_id", peerId.toString())), headers), String.class);
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("chat create failed: "
                    + response.getStatusCode() + " " + response.getBody());
        }
        return UUID.fromString(json(response.getBody()).get("id").asText());
    }

    private JsonNode send(SessionResponse session, UUID deviceId, UUID chatId,
                          Map<String, Object> body) throws Exception {
        HttpHeaders headers = withIdempotency(headers(session.accessToken(), deviceId));
        ResponseEntity<String> response = rest.exchange(
                url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.POST,
                new HttpEntity<>(objectMapper.writeValueAsString(body), headers), String.class);
        if (response.getStatusCode().value() != 201) {
            throw new IllegalStateException("send failed: " + response.getStatusCode()
                    + " " + response.getBody());
        }
        return json(response.getBody());
    }

    private HttpHeaders withIdempotency(HttpHeaders headers) {
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        return headers;
    }

    private Map<String, Object> e2eeBody(UUID clientMessageId,
                                         List<Map<String, Object>> envelopes) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", clientMessageId.toString());
        body.put("type", "TEXT");
        body.put("envelopes", envelopes);
        return body;
    }

    private Map<String, Object> envelope(UUID chatId, Device sender, Device recipient,
                                         byte[] ciphertext, boolean prekey) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("v", 1);
        envelope.put("scheme", "PAIRWISE_X3DH_DR");
        envelope.put("chat_id", chatId.toString());
        envelope.put("sender_device_id", sender.id().toString());
        envelope.put("sender_key_generation", 1);
        envelope.put("recipient_device_id", recipient.id().toString());
        envelope.put("recipient_key_generation", 1);
        envelope.put("session_id", Base64Url.encode(random(16)));
        envelope.put("header", Map.of("v", 1, "dh", Base64Url.encode(random(32)),
                "pn", 0, "n", 0));
        envelope.put("ciphertext", Base64Url.encode(ciphertext));
        if (prekey) {
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("sender_identity_signing_key",
                    Base64Url.encode(sender.material().identitySigningKey()));
            block.put("sender_identity_dh_key",
                    Base64Url.encode(sender.material().identityDhKey()));
            block.put("sender_ephemeral_key", Base64Url.encode(random(32)));
            block.put("recipient_identity_dh_key",
                    Base64Url.encode(recipient.material().identityDhKey()));
            block.put("spk_id", "spk-1");
            block.put("spk_public", Base64Url.encode(random(32)));
            block.put("opk_id", null);
            block.put("opk_public", null);
            block.put("signature", Base64Url.encode(random(64)));
            envelope.put("prekey", block);
        }
        return envelope;
    }

    private static byte[] random(int size) {
        byte[] value = new byte[size];
        java.util.concurrent.ThreadLocalRandom.current().nextBytes(value);
        return value;
    }
}
