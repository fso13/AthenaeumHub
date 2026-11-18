package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.WebSocketIntegrationTestBase;
import ru.krug.backend.support.WsTestClient;

/**
 * E2EE-REVIEW-07 P1-03 regression on real HTTP (RANDOM_PORT, real Tomcat) and real
 * PostgreSQL.
 *
 * <p>An upgraded database can contain envelopes written before the canonical 272-byte
 * floor (V18 is NOT VALID). The read path must answer 200 with {@code crypto:null} for the
 * addressed device instead of constructing a {@code CryptoEnvelope} and returning 500.
 * V19 must then move exactly those rows into the quarantine table and validate the
 * constraint, without touching valid envelopes.
 */
@ActiveProfiles("test")
@TestPropertySource(properties = "krug.e2ee.enabled=true")
class E2eeLegacyEnvelopeIT extends WebSocketIntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void legacyShortEnvelopeIsNullOnRealHttpGetAndIsQuarantinedByV19() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "legacy-a1");
        Device a2 = registerDevice(alice, "legacy-a2");
        Device b1 = registerDevice(bob, "legacy-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);
        SessionResponse a2Session = withDevice(alice, a2.id(), workspaceId);
        SessionResponse bobSession = withDevice(bob, b1.id(), workspaceId);

        // Only B1 is addressed; A2 has no valid envelope for this message.
        byte[] toBob = random(300);
        UUID clientMessageId = UUID.randomUUID();
        Map<String, Object> body = e2eeBody(clientMessageId,
                List.of(envelope(chatId, a1, b1, toBob, true)));
        UUID idempotencyKey = UUID.randomUUID();
        JsonNode sent = send(aliceSession, a1.id(), chatId, body, idempotencyKey);
        UUID messageId = UUID.fromString(sent.get("id").asText());

        boolean constraintTouched = false;
        try {
            // Model the V17->V18 upgrade state: V18 constraint present but NOT VALID, and a
            // 16-byte row written before the floor. This is exactly the state review-07
            // reproduced as a 500.
            dropV18Constraint();
            constraintTouched = true;
            insertLegacyEnvelope(messageId, a2.id(), a1.id(), workspaceId, chatId, 16);
            addV18ConstraintNotValid();
            assertThat(v18ConstraintValidated()).isFalse();
            assertThat(legacyRowCount(messageId)).isEqualTo(1);

            // Real HTTP GET as A2: 200 crypto:null, never 500. The valid B1 envelope still
            // works, and the message itself is still visible to both devices.
            JsonNode a2Page = getMessages(a2Session, a2.id(), chatId);
            CONTRACT.assertValid("MessagePage", a2Page);
            JsonNode a2Message = item(a2Page, messageId);
            assertThat(a2Message.get("crypto").isNull()).isTrue();
            assertThat(a2Message.get("text").isNull()).isTrue();

            JsonNode b1Page = getMessages(bobSession, b1.id(), chatId);
            CONTRACT.assertValid("MessagePage", b1Page);
            JsonNode b1Message = item(b1Page, messageId);
            CONTRACT.assertValid("CryptoEnvelope", b1Message.get("crypto"));
            assertThat(b1Message.get("crypto").get("recipient_device_id").asText())
                    .isEqualTo(b1.id().toString());
            assertThat(Base64Url.decode(b1Message.get("crypto").get("ciphertext").asText())
                    .orElseThrow()).isEqualTo(toBob);

            // The internal replay path also maps envelopes (`findByMessage`): both the
            // Idempotency-Key replay and the client_message_id replay must stay 2xx.
            ResponseEntity<String> sameKey = postMessage(aliceSession, a1.id(), chatId, body,
                    idempotencyKey);
            assertThat(sameKey.getStatusCode().value()).isEqualTo(201);
            assertThat(json(sameKey.getBody()).get("id").asText()).isEqualTo(messageId.toString());

            ResponseEntity<String> byClientId = postMessage(aliceSession, a1.id(), chatId, body,
                    UUID.randomUUID());
            assertThat(byClientId.getStatusCode().value()).isEqualTo(201);
            assertThat(json(byClientId.getBody()).get("id").asText())
                    .isEqualTo(messageId.toString());

            // V19: quarantine the invalid row, keep the valid one, validate the constraint.
            executeV19();

            assertThat(legacyRowCount(messageId)).isZero();
            assertThat(validRowCount(messageId)).isEqualTo(1);
            assertThat(quarantineCount(messageId)).isEqualTo(1);
            assertThat(quarantineReason(messageId)).isEqualTo("legacy_short");
            assertThat(v18ConstraintValidated()).isTrue();
            assertThat(allPartitionsValidated()).isTrue();
            assertThat(validCiphertextPreserved(messageId, toBob)).isTrue();

            // The same GET stays 200 crypto:null after V19 (no row, no exception).
            JsonNode afterV19 = getMessages(a2Session, a2.id(), chatId);
            assertThat(item(afterV19, messageId).get("crypto").isNull()).isTrue();
            JsonNode b1After = getMessages(bobSession, b1.id(), chatId);
            assertThat(item(b1After, messageId).get("crypto").get("recipient_device_id").asText())
                    .isEqualTo(b1.id().toString());
        } finally {
            if (constraintTouched) {
                restoreConstraintAfterTest(messageId);
            }
        }
    }

    /**
     * P2-12: the 271-byte lower boundary is also exercised over real HTTP, not only by the
     * SQL predicate and the migration IT.
     */
    @Test
    void legacy271ByteEnvelopeIsNullOnRealHttpAndQuarantinedByV19() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "legacy271-a1");
        Device a2 = registerDevice(alice, "legacy271-a2");
        Device b1 = registerDevice(bob, "legacy271-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);
        SessionResponse a2Session = withDevice(alice, a2.id(), workspaceId);
        SessionResponse bobSession = withDevice(bob, b1.id(), workspaceId);

        byte[] toBob = random(300);
        UUID messageId = UUID.fromString(send(aliceSession, a1.id(), chatId,
                e2eeBody(UUID.randomUUID(), List.of(envelope(chatId, a1, b1, toBob, true))),
                UUID.randomUUID()).get("id").asText());

        boolean constraintTouched = false;
        try {
            dropV18Constraint();
            constraintTouched = true;
            insertLegacyEnvelope(messageId, a2.id(), a1.id(), workspaceId, chatId, 271);
            addV18ConstraintNotValid();
            assertThat(legacyRowCount(messageId)).isEqualTo(1);

            JsonNode a2Page = getMessages(a2Session, a2.id(), chatId);
            CONTRACT.assertValid("MessagePage", a2Page);
            assertThat(item(a2Page, messageId).get("crypto").isNull()).isTrue();

            JsonNode b1Page = getMessages(bobSession, b1.id(), chatId);
            assertThat(Base64Url.decode(item(b1Page, messageId).get("crypto")
                    .get("ciphertext").asText()).orElseThrow()).isEqualTo(toBob);

            executeV19();

            assertThat(legacyRowCount(messageId)).isZero();
            assertThat(quarantineCount(messageId)).isEqualTo(1);
            assertThat(quarantineReason(messageId)).isEqualTo("legacy_short");
            assertThat(v18ConstraintValidated()).isTrue();
            assertThat(validCiphertextPreserved(messageId, toBob)).isTrue();
            assertThat(item(getMessages(a2Session, a2.id(), chatId), messageId)
                    .get("crypto").isNull()).isTrue();
        } finally {
            if (constraintTouched) {
                restoreConstraintAfterTest(messageId);
            }
        }
    }

    /**
     * P2-09 decision: a message whose only envelope is legacy (quarantined by V19 or written
     * before B3F) can be replayed through the idempotency identity, but a new identity with
     * a valid-but-different body is a conflict and the original short bytes are rejected.
     * Never 500, never a silently re-created message.
     */
    @Test
    void legacyOnlyReplayIsDocumented422Or409AndNever500() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "legacy-only-a1");
        Device a2 = registerDevice(alice, "legacy-only-a2");
        Device b1 = registerDevice(bob, "legacy-only-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);
        SessionResponse bobSession = withDevice(bob, b1.id(), workspaceId);

        byte[] original = random(300);
        UUID clientMessageId = UUID.randomUUID();
        Map<String, Object> body = e2eeBody(clientMessageId,
                List.of(envelope(chatId, a1, b1, original, true)));
        UUID idempotencyKey = UUID.randomUUID();
        UUID messageId = UUID.fromString(send(aliceSession, a1.id(), chatId, body,
                idempotencyKey).get("id").asText());

        boolean constraintTouched = false;
        try {
            // Make the message legacy-only: its single stored envelope becomes 16 B.
            dropV18Constraint();
            constraintTouched = true;
            migrator().update("""
                    UPDATE message.message_envelopes
                       SET ciphertext = CAST(? AS bytea)
                     WHERE message_id = ? AND recipient_device_id = ?
                    """, random(16), messageId, b1.id());
            addV18ConstraintNotValid();
            assertThat(validRowCount(messageId)).isZero();
            assertThat(legacyRowCount(messageId)).isEqualTo(1);

            // A true idempotency replay (same key + same body) stays 201 and does not need
            // the stored envelope to be readable.
            ResponseEntity<String> sameKey = postMessage(aliceSession, a1.id(), chatId, body,
                    idempotencyKey);
            assertThat(sameKey.getStatusCode().value()).isEqualTo(201);
            assertThat(sameKey.getHeaders().getFirst("Idempotent-Replay")).isEqualTo("true");
            assertThat(json(sameKey.getBody()).get("id").asText())
                    .isEqualTo(messageId.toString());

            // New Idempotency-Key, same client_message_id, valid but different bytes: the
            // stored fingerprints are empty, so this is a content conflict (not 201).
            ResponseEntity<String> newKey = postMessage(aliceSession, a1.id(), chatId,
                    e2eeBody(clientMessageId, List.of(envelope(chatId, a1, b1, random(300),
                            true))), UUID.randomUUID());
            assertThat(newKey.getStatusCode().value()).isEqualTo(409);
            assertThat(json(newKey.getBody()).get("code").asText())
                    .isEqualTo("CLIENT_MESSAGE_ID_CONFLICT");

            // Same key, different valid body: the idempotency identity is already used.
            ResponseEntity<String> differentBody = postMessage(aliceSession, a1.id(), chatId,
                    e2eeBody(clientMessageId, List.of(envelope(chatId, a1, b1, random(300),
                            true))), idempotencyKey);
            assertThat(differentBody.getStatusCode().value()).isEqualTo(409);
            assertThat(json(differentBody.getBody()).get("code").asText())
                    .isEqualTo("IDEMPOTENCY_KEY_REUSED");

            // Replaying the now-invalid short bytes is rejected by the codec before any
            // replay branch; it must be a 422, not a 500 and not a second message.
            ResponseEntity<String> shortReplay = postMessage(aliceSession, a1.id(), chatId,
                    e2eeBody(clientMessageId, List.of(envelope(chatId, a1, b1, random(16),
                            true))), UUID.randomUUID());
            assertThat(shortReplay.getStatusCode().value()).isEqualTo(422);
            assertThat(json(shortReplay.getBody()).get("code").asText())
                    .isEqualTo("INVALID_ENVELOPE_FORMAT");
            assertThat(json(shortReplay.getBody()).get("details").get("reason").asText())
                    .isEqualTo("ciphertext_too_short");

            // The message stays visible with crypto:null for the affected device.
            JsonNode b1Page = getMessages(bobSession, b1.id(), chatId);
            assertThat(item(b1Page, messageId).get("crypto").isNull()).isTrue();
        } finally {
            if (constraintTouched) {
                restoreConstraintAfterTest(messageId);
            }
        }
    }

    /**
     * P2-12: the WS history adapter uses the same tolerant repository; a legacy row must
     * replay as {@code crypto:null} on the socket instead of failing the frame.
     */
    @Test
    void legacyEnvelopeIsNullOnWsReplay() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        Device a1 = registerDevice(alice, "ws-legacy-a1");
        Device a2 = registerDevice(alice, "ws-legacy-a2");
        Device b1 = registerDevice(bob, "ws-legacy-b1");
        UUID chatId = createDirect(alice, workspaceId, bob.user().id());
        SessionResponse aliceSession = withDevice(alice, a1.id(), workspaceId);
        SessionResponse a2Session = withDevice(alice, a2.id(), workspaceId);
        SessionResponse bobSession = withDevice(bob, b1.id(), workspaceId);

        byte[] toBob = random(300);
        UUID messageId = UUID.fromString(send(aliceSession, a1.id(), chatId,
                e2eeBody(UUID.randomUUID(), List.of(envelope(chatId, a1, b1, toBob, true))),
                UUID.randomUUID()).get("id").asText());

        boolean constraintTouched = false;
        try {
            dropV18Constraint();
            constraintTouched = true;
            insertLegacyEnvelope(messageId, a2.id(), a1.id(), workspaceId, chatId, 16);
            addV18ConstraintNotValid();

            WsTestClient a2Ws = connect(a2Session);
            try {
                subscribe(a2Ws, chatId, 0);
                JsonNode noCrypto = a2Ws.awaitEvent("message.created", TIMEOUT);
                assertThat(noCrypto.get("payload").get("text").isNull()).isTrue();
                assertThat(noCrypto.get("payload").get("crypto").isNull()).isTrue();
            } finally {
                a2Ws.close();
            }

            WsTestClient b1Ws = connect(bobSession);
            try {
                subscribe(b1Ws, chatId, 0);
                JsonNode withCrypto = b1Ws.awaitEvent("message.created", TIMEOUT);
                JsonNode crypto = withCrypto.get("payload").get("crypto");
                CONTRACT.assertValid("CryptoEnvelope", crypto);
                assertThat(crypto.get("recipient_device_id").asText())
                        .isEqualTo(b1.id().toString());
                assertThat(Base64Url.decode(crypto.get("ciphertext").asText())
                        .orElseThrow()).isEqualTo(toBob);
            } finally {
                b1Ws.close();
            }
        } finally {
            if (constraintTouched) {
                restoreConstraintAfterTest(messageId);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Helpers: V19 / DB state
    // ---------------------------------------------------------------------
    private void executeV19() throws Exception {
        try (Connection connection = migrator().getDataSource().getConnection()) {
            connection.setAutoCommit(false);
            ScriptUtils.executeSqlScript(connection,
                    new ClassPathResource("db/migration/V19__e2ee_legacy_envelope_quarantine.sql"));
            connection.commit();
        }
    }

    /**
     * Test isolation on the shared container: remove any legacy/quarantine residue and
     * leave the V18 constraint present and validated, so the other IT classes see the same
     * state as a normal Flyway startup.
     */
    private void restoreConstraintAfterTest(UUID messageId) {
        migrator().update("""
                DELETE FROM message.message_envelopes
                 WHERE message_id = ? AND octet_length(ciphertext) < 272
                """, messageId);
        migrator().update("""
                DELETE FROM message.message_envelopes_quarantine WHERE message_id = ?
                """, messageId);
        migrator().execute("""
                ALTER TABLE message.message_envelopes FORCE ROW LEVEL SECURITY
                """);
        dropV18Constraint();
        addV18ConstraintNotValid();
        migrator().execute("""
                ALTER TABLE message.message_envelopes
                  VALIDATE CONSTRAINT ck_envelopes_ciphertext_min
                """);
    }

    private void dropV18Constraint() {
        migrator().execute("""
                ALTER TABLE message.message_envelopes
                  DROP CONSTRAINT IF EXISTS ck_envelopes_ciphertext_min
                """);
    }

    private void addV18ConstraintNotValid() {
        migrator().execute("""
                ALTER TABLE message.message_envelopes
                  ADD CONSTRAINT ck_envelopes_ciphertext_min
                  CHECK (octet_length(ciphertext) BETWEEN 272 AND 33040) NOT VALID
                """);
    }

    private boolean v18ConstraintValidated() {
        Boolean validated = migrator().queryForObject("""
                SELECT convalidated FROM pg_constraint
                 WHERE conrelid = 'message.message_envelopes'::regclass
                   AND conname = 'ck_envelopes_ciphertext_min'
                """, Boolean.class);
        return Boolean.TRUE.equals(validated);
    }

    private boolean allPartitionsValidated() {
        Integer unvalidated = migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint c
                  JOIN pg_inherits i ON i.inhrelid = c.conrelid
                 WHERE i.inhparent = 'message.message_envelopes'::regclass
                   AND c.conname = 'ck_envelopes_ciphertext_min'
                   AND NOT c.convalidated
                """, Integer.class);
        return unvalidated != null && unvalidated == 0;
    }

    private int legacyRowCount(UUID messageId) {
        Integer count = migrator().queryForObject("""
                SELECT count(*) FROM message.message_envelopes
                 WHERE message_id = ? AND octet_length(ciphertext) < 272
                """, Integer.class, messageId);
        return count == null ? 0 : count;
    }

    private int validRowCount(UUID messageId) {
        Integer count = migrator().queryForObject("""
                SELECT count(*) FROM message.message_envelopes
                 WHERE message_id = ? AND octet_length(ciphertext) BETWEEN 272 AND 33040
                """, Integer.class, messageId);
        return count == null ? 0 : count;
    }

    private int quarantineCount(UUID messageId) {
        Integer count = migrator().queryForObject("""
                SELECT count(*) FROM message.message_envelopes_quarantine
                 WHERE message_id = ?
                """, Integer.class, messageId);
        return count == null ? 0 : count;
    }

    private String quarantineReason(UUID messageId) {
        return migrator().queryForObject("""
                SELECT reason FROM message.message_envelopes_quarantine WHERE message_id = ?
                """, String.class, messageId);
    }

    private boolean validCiphertextPreserved(UUID messageId, byte[] expected) {
        byte[] stored = migrator().queryForObject("""
                SELECT ciphertext FROM message.message_envelopes
                 WHERE message_id = ? AND octet_length(ciphertext) BETWEEN 272 AND 33040
                """, byte[].class, messageId);
        return java.util.Arrays.equals(expected, stored);
    }

    private void insertLegacyEnvelope(UUID messageId, UUID recipientDeviceId,
                                      UUID senderDeviceId, UUID workspaceId, UUID chatId,
                                      int ciphertextBytes) throws Exception {
        String header = objectMapper.writeValueAsString(Map.of(
                "v", 1, "dh", Base64Url.encode(random(32)), "pn", 0, "n", 0));
        migrator().update("""
                INSERT INTO message.message_envelopes
                       (message_id, recipient_device_id, sender_device_id, workspace_id,
                        chat_id, scheme, sender_key_generation, recipient_key_generation,
                        session_id, header, ciphertext, prekey, created_at)
                VALUES (?, ?, ?, ?, ?, 'PAIRWISE_X3DH_DR', 1, 1,
                        CAST(? AS bytea), CAST(? AS jsonb), CAST(? AS bytea), NULL, now())
                """, messageId, recipientDeviceId, senderDeviceId, workspaceId, chatId,
                random(16), header, random(ciphertextBytes));
    }

    // ---------------------------------------------------------------------
    // Helpers: real HTTP
    // ---------------------------------------------------------------------

    private WsTestClient connect(SessionResponse session) throws Exception {
        String ticket = ticket(session).get("ticket").asText();
        WsTestClient client = WsTestClient.connect(objectMapper, port, ticket,
                "http://localhost:5173");
        client.awaitType("hello", TIMEOUT);
        return client;
    }

    private void subscribe(WsTestClient client, UUID chatId, long lastSeq) {
        client.send("{\"v\":1,\"type\":\"subscribe\",\"chats\":[{\"chat_id\":\""
                + chatId + "\",\"last_seq\":" + lastSeq + "}],\"presence\":false}");
        JsonNode subscribed = client.awaitType("subscribed", TIMEOUT);
        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean())
                .as(subscribed.toString()).isTrue();
    }

    private JsonNode getMessages(SessionResponse session, UUID deviceId, UUID chatId)
            throws Exception {
        HttpHeaders headers = headers(session.accessToken(), deviceId);
        ResponseEntity<String> response = rest.exchange(
                url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
        assertThat(response.getStatusCode().value())
                .as("GET history must never 500 for a legacy envelope: %s", response.getBody())
                .isEqualTo(200);
        return json(response.getBody());
    }

    private JsonNode item(JsonNode page, UUID messageId) {
        for (JsonNode item : page.get("items")) {
            if (messageId.toString().equals(item.get("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("message " + messageId + " not present in " + page);
    }

    private JsonNode send(SessionResponse session, UUID deviceId, UUID chatId,
                          Map<String, Object> body, UUID idempotencyKey) throws Exception {
        ResponseEntity<String> response = postMessage(session, deviceId, chatId, body,
                idempotencyKey);
        assertThat(response.getStatusCode().value())
                .as("send failed: %s", response.getBody()).isEqualTo(201);
        return json(response.getBody());
    }

    private ResponseEntity<String> postMessage(SessionResponse session, UUID deviceId,
                                               UUID chatId, Map<String, Object> body,
                                               UUID idempotencyKey) throws Exception {
        HttpHeaders headers = headers(session.accessToken(), deviceId);
        headers.add("Idempotency-Key", idempotencyKey.toString());
        headers.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange(url("/api/v1/chats/" + chatId + "/messages"), HttpMethod.POST,
                new HttpEntity<>(objectMapper.writeValueAsString(body), headers), String.class);
    }

    private HttpHeaders headers(String token, UUID deviceId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.add("X-Device-Id", deviceId.toString());
        return headers;
    }

    private HttpHeaders withIdempotency(HttpHeaders headers) {
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        return headers;
    }

    // ---------------------------------------------------------------------
    // Fixture
    // ---------------------------------------------------------------------

    private record Device(UUID id, Material material) {
    }

    private SessionResponse withDevice(SessionResponse session, UUID deviceId,
                                       UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), deviceId, workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                new SessionResponse.DeviceInfo(deviceId, "WEB"), session.workspace(),
                session.chat());
    }

    private UUID createE2eeWorkspace(SessionResponse owner) throws Exception {
        HttpHeaders headers = withIdempotency(headers(owner.accessToken(),
                owner.device().id()));
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> response = rest.exchange(url("/api/v1/workspaces"),
                HttpMethod.POST, new HttpEntity<>(objectMapper.writeValueAsString(Map.of(
                        "name", "e2ee-legacy-" + UUID.randomUUID(),
                        "security_mode", "E2EE")), headers), String.class);
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
        headers.setContentType(MediaType.APPLICATION_JSON);
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
        headers.setContentType(MediaType.APPLICATION_JSON);
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
