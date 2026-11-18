package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
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
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.DeviceKeyTestSupport;
import ru.krug.backend.support.DeviceKeyTestSupport.Material;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E7-B3/B4 — E2EE chat creation, opaque envelope send/storage/fan-out and per-device
 * history. The server is treated as an untrusted relay: it validates public shape and
 * rights only, never decrypts, never stores plaintext and never returns another device's
 * envelope.
 */
@org.springframework.boot.test.context.SpringBootTest(properties = "krug.e2ee.enabled=true")
@ActiveProfiles("test")
class E2eeMessageIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final SecureRandom RANDOM = new SecureRandom();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void flagOnCreatesImmutableE2eeDirectWithoutSystemMessages() throws Exception {
        Fixture fixture = fixture();
        register(fixture.alice(), "a1");
        register(fixture.bob(), "b1");

        JsonNode chat = createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201);
        CONTRACT.assertValid("Chat", chat);
        assertThat(chat.get("security_mode").asText()).isEqualTo("E2EE");
        assertThat(chat.get("type").asText()).isEqualTo("DIRECT");
        assertThat(chat.get("peer_has_e2ee_capable_devices").asBoolean()).isTrue();
        UUID chatId = UUID.fromString(chat.get("id").asText());

        // No server-generated plaintext system messages exist in an E2EE chat.
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM message.messages WHERE chat_id = ?", Integer.class,
                chatId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM message.messages
                 WHERE chat_id = ? AND type = 'SYSTEM'
                """, Integer.class, chatId)).isZero();

        // E2EE GROUP is rejected by the shared domain rule.
        JsonNode group = createDirectBody(fixture.alice(), fixture.workspaceId(),
                Map.of("type", "GROUP", "name", "nope"), 409);
        assertThat(group.get("code").asText()).isEqualTo("E2EE_GROUP_NOT_SUPPORTED");

        // Repeated DIRECT returns 200 with the same chat; security_mode stayed E2EE.
        JsonNode repeated = createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 200);
        assertThat(repeated.get("id").asText()).isEqualTo(chatId.toString());

        // security_mode is immutable at the database level too (P0-3).
        assertThatThrownBy(() -> migrator().update(
                "UPDATE chat.chats SET security_mode = 'MANAGED' WHERE id = ?", chatId))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("MODE_CHANGE_FORBIDDEN");
        assertThatThrownBy(() -> migrator().update(
                "UPDATE workspace.workspaces SET security_mode = 'MANAGED' WHERE id = ?",
                fixture.workspaceId()))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("MODE_CHANGE_FORBIDDEN");
    }

    @Test
    void sendStoresOpaqueEnvelopesAndReturnsHonestCoverage() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device a2 = register(fixture.alice(), "a2");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        byte[] toBob = random(300);
        byte[] toSelf = random(300);
        Map<String, Object> body = e2eeBody(UUID.randomUUID(), List.of(
                envelope(chatId, a1, a1.material(), b1, b1.material(), toBob, true),
                envelope(chatId, a1, a1.material(), a2, a1.material(), toSelf,
                        false)));
        JsonNode sent = send(fixture.alice(), a1, chatId, body, 201);
        CONTRACT.assertValid("MessageCreateResult", sent);
        assertThat(sent.get("text").isNull()).isTrue();
        assertThat(sent.get("crypto").isNull()).isTrue();
        assertThat(sent.get("type").asText()).isEqualTo("TEXT");
        assertThat(sent.get("seq").asLong()).isEqualTo(1);
        assertThat(sent.get("client_message_id").asText())
                .isEqualTo(body.get("client_message_id").toString());

        JsonNode coverage = sent.get("envelope_coverage");
        assertThat(coverage.get("peer_devices").asInt()).isEqualTo(1);
        assertThat(coverage.get("peer_covered").asInt()).isEqualTo(1);
        assertThat(coverage.get("self_devices").asInt()).isEqualTo(1);
        assertThat(coverage.get("self_covered").asInt()).isEqualTo(1);
        assertThat(coverage.get("devices").asInt()).isEqualTo(2);
        assertThat(coverage.get("covered").asInt()).isEqualTo(2);
        assertThat(coverage.get("warning").isNull()).isTrue();
        assertThat(coverage.get("uncovered_device_ids").size()).isZero();

        // The message row holds no plaintext and no managed payload.
        Map<String, Object> row = migrator().queryForMap("""
                SELECT crypto_scheme, body_ciphertext, content_meta::text AS content_meta, type,
                       sender_device_id, reply_to_id, sticker_id
                  FROM message.messages WHERE id = ?
                """, UUID.fromString(sent.get("id").asText()));
        assertThat(row.get("crypto_scheme")).isEqualTo("E2EE_PAIRWISE");
        assertThat(row.get("body_ciphertext")).isNull();
        assertThat(row.get("content_meta")).isEqualTo("{}");
        assertThat(row.get("type")).isEqualTo("TEXT");
        assertThat(row.get("sender_device_id")).isEqualTo(a1.id());
        assertThat(row.get("reply_to_id")).isNull();
        assertThat(row.get("sticker_id")).isNull();

        // Envelopes are opaque: the stored ciphertext is byte-identical to the request.
        List<Map<String, Object>> envelopes = migrator().queryForList("""
                SELECT recipient_device_id, sender_device_id, ciphertext, session_id, prekey
                  FROM message.message_envelopes WHERE message_id = ?
                 ORDER BY recipient_device_id
                """, UUID.fromString(sent.get("id").asText()));
        assertThat(envelopes).hasSize(2);
        assertThat(envelopes).anySatisfy(envelope -> {
            assertThat(envelope.get("recipient_device_id")).isEqualTo(b1.id());
            assertThat(envelope.get("sender_device_id")).isEqualTo(a1.id());
            assertThat((byte[]) envelope.get("ciphertext")).isEqualTo(toBob);
            assertThat(envelope.get("prekey")).isNotNull();
        });
        assertThat(envelopes).anySatisfy(envelope -> {
            assertThat(envelope.get("recipient_device_id")).isEqualTo(a2.id());
            assertThat((byte[]) envelope.get("ciphertext")).isEqualTo(toSelf);
            assertThat(envelope.get("prekey")).isNull();
        });

        // Second message gets the next seq; no partial writes on the first.
        JsonNode second = send(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(envelope(chatId, a1, a1.material(),
                        b1, b1.material(), random(300), true))), 201);
        assertThat(second.get("seq").asLong()).isEqualTo(2);
    }

    @Test
    void partialCoverageWarnsHonestly() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device a2 = register(fixture.alice(), "a2");
        Device b1 = register(fixture.bob(), "b1");
        Device b2 = register(fixture.bob(), "b2");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        // Peer and self both partially covered: the peer warning wins.
        JsonNode partial = send(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), b1, b1.material(), random(300),
                        true))), 201);
        JsonNode coverage = partial.get("envelope_coverage");
        assertThat(coverage.get("peer_devices").asInt()).isEqualTo(2);
        assertThat(coverage.get("peer_covered").asInt()).isEqualTo(1);
        assertThat(coverage.get("self_devices").asInt()).isEqualTo(1);
        assertThat(coverage.get("self_covered").asInt()).isZero();
        assertThat(coverage.get("warning").asText()).isEqualTo("PEER_DEVICE_UNCOVERED");
        assertThat(coverage.get("uncovered_device_ids").toString())
                .contains(b2.id().toString()).contains(a2.id().toString())
                .doesNotContain(b1.id().toString());

        // Peer fully covered, self not: SELF_DEVICE_UNCOVERED.
        JsonNode selfOnly = send(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), b1, b1.material(), random(300),
                        true),
                        envelope(chatId, a1, a1.material(), b2, b2.material(), random(300),
                                true))), 201);
        assertThat(selfOnly.get("envelope_coverage").get("warning").asText())
                .isEqualTo("SELF_DEVICE_UNCOVERED");
        assertThat(selfOnly.get("envelope_coverage").get("peer_covered").asInt()).isEqualTo(2);

        // Unknown header field is a format error, not silently ignored.
        Map<String, Object> unknownHeader = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        unknownHeader.put("header", Map.of("v", 1, "dh",
                Base64Url.encode(random(32)), "pn", 0, "n", 0, "extra", 1));
        assertThat(expectError(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(unknownHeader)), 422).get("details").get("field").asText())
                .contains("header.extra");
    }

    @Test
    void plaintextPayloadIsRejectedWithoutConsumingSeq() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());
        List<Map<String, Object>> valid = List.of(envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true));

        assertPlaintext(fixture.alice(), a1, chatId, valid, "text", "hello");
        assertPlaintext(fixture.alice(), a1, chatId, valid, "sticker_id",
                UUID.randomUUID().toString());
        assertPlaintext(fixture.alice(), a1, chatId, valid, "attachment_ids",
                List.of(UUID.randomUUID().toString()));
        assertPlaintext(fixture.alice(), a1, chatId, valid, "reply_to_id",
                UUID.randomUUID().toString());

        // A STICKER type is not a valid E2EE message either.
        Map<String, Object> sticker = new LinkedHashMap<>();
        sticker.put("client_message_id", UUID.randomUUID().toString());
        sticker.put("type", "STICKER");
        sticker.put("envelopes", valid);
        JsonNode stickerError = expectError(fixture.alice(), a1, chatId, sticker, 422);
        assertThat(stickerError.get("code").asText()).isEqualTo("E2EE_PLAINTEXT_FORBIDDEN");
        assertThat(stickerError.get("details").get("field").asText()).isEqualTo("type");

        assertThat(messageCount(chatId)).isZero();
        JsonNode first = send(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(), valid),
                201);
        assertThat(first.get("seq").asLong()).isEqualTo(1);
    }

    @Test
    void invalidEnvelopeShapesAreRejected() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());
        Map<String, Object> valid = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);

        // Missing / empty envelopes.
        for (Object envelopes : new Object[] {null, List.of()}) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("client_message_id", UUID.randomUUID().toString());
            body.put("type", "TEXT");
            if (envelopes != null) {
                body.put("envelopes", envelopes);
            }
            JsonNode error = expectError(fixture.alice(), a1, chatId, body, 422);
            assertThat(error.get("code").asText()).isEqualTo("ENVELOPES_REQUIRED");
        }

        // More than 10 envelopes.
        List<Map<String, Object>> many = new ArrayList<>();
        for (int i = 0; i < 11; i++) {
            many.add(valid);
        }
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), many), 422).get("code").asText())
                .isEqualTo("TOO_MANY_ENVELOPES");

        // Duplicate recipient.
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(valid, valid)), 422).get("code").asText())
                .isEqualTo("DUPLICATE_ENVELOPE");

        // Unsupported version.
        Map<String, Object> badVersion = new LinkedHashMap<>(valid);
        badVersion.put("v", 2);
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(badVersion)), 422).get("code").asText())
                .isEqualTo("UNSUPPORTED_ENVELOPE_VERSION");

        // Unknown field (schema smuggling).
        Map<String, Object> unknown = new LinkedHashMap<>(valid);
        unknown.put("plaintext", "oops");
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(unknown)), 422).get("code").asText())
                .isEqualTo("INVALID_ENVELOPE_FORMAT");

        // Non-canonical base64 (padded) session id.
        Map<String, Object> padded = new LinkedHashMap<>(valid);
        padded.put("session_id", Base64Url.encode(random(16)) + "==");
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(padded)), 422).get("code").asText())
                .isEqualTo("INVALID_ENVELOPE_FORMAT");

        // Ciphertext too short / too large.
        Map<String, Object> shortCiphertext = new LinkedHashMap<>(valid);
        shortCiphertext.put("ciphertext", Base64Url.encode(random(15)));
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(shortCiphertext)), 422).get("code")
                .asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");

        Map<String, Object> largeCiphertext = new LinkedHashMap<>(valid);
        largeCiphertext.put("ciphertext", Base64Url.encode(random(33041)));
        JsonNode large = expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(largeCiphertext)), 413);
        assertThat(large.get("code").asText()).isEqualTo("ENVELOPE_TOO_LARGE");
        assertThat(large.get("details").get("reason").asText()).isEqualTo("canonical");

        // Form guard (encoded string above 65536) is rejected before decoding.
        Map<String, Object> formGuard = new LinkedHashMap<>(valid);
        formGuard.put("ciphertext", "A".repeat(70000));
        JsonNode form = expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(formGuard)), 413);
        assertThat(form.get("code").asText()).isEqualTo("ENVELOPE_TOO_LARGE");
        assertThat(form.get("details").get("reason").asText()).isEqualTo("form");

        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void ciphertextFloorIsCanonicalPaddedBody() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        // 16 decoded bytes = 22 base64url characters: the old floor. It must now be 422.
        Map<String, Object> sixteen = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(16), true);
        JsonNode short16 = expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(sixteen)), 422);
        assertThat(short16.get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");
        assertThat(short16.get("details").get("reason").asText())
                .isEqualTo("ciphertext_too_short");

        // 271 bytes = 362 characters: one byte below the canonical padded floor.
        Map<String, Object> twoSeventyOne = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(271), true);
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(twoSeventyOne)), 422)
                .get("details").get("reason").asText()).isEqualTo("ciphertext_too_short");
        assertThat(messageCount(chatId)).isZero();

        // 272 bytes = 363 characters: the smallest contract-valid envelope.
        JsonNode sent = send(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), b1, b1.material(),
                        random(272), true))), 201);
        CONTRACT.assertValid("MessageCreateResult", sent);
        JsonNode crypto = list(fixture.bob(), b1, chatId).get("items").get(0).get("crypto");
        CONTRACT.assertValid("CryptoEnvelope", crypto);
        assertThat(crypto.get("ciphertext").asText()).hasSize(363);
        assertThat(Base64Url.decode(crypto.get("ciphertext").asText()).orElseThrow())
                .hasSize(272);
        assertThat(messageCount(chatId)).isEqualTo(1);

        // Storage backstop: V18 rejects a 271-byte row inserted around the API.
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO message.message_envelopes
                       (message_id, recipient_device_id, sender_device_id, workspace_id,
                        chat_id, scheme, sender_key_generation, recipient_key_generation,
                        session_id, header, ciphertext, prekey, created_at)
                VALUES (?, ?, ?, ?, ?, 'PAIRWISE_X3DH_DR', 1, 1,
                        CAST(? AS bytea), CAST('{}' AS jsonb), CAST(? AS bytea), NULL, now())
                """, UUID.randomUUID(), b1.id(), a1.id(), fixture.workspaceId(), chatId,
                random(16), random(271)))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("ck_envelopes_ciphertext_min");

        // The domain and SQL capability predicates agree for a registered capable device.
        assertThat(migrator().queryForObject("""
                SELECT auth.device_is_e2ee_capable(status, identity_key_alg,
                       identity_signing_key, identity_dh_key, identity_binding_signature,
                       fingerprint)
                  FROM auth.devices WHERE id = ?
                """, Boolean.class, b1.id())).isTrue();
    }

    @Test
    void replayAfterPeerRevokeReportsHonestZeroCoverage() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());
        UUID clientMessageId = UUID.randomUUID();
        Map<String, Object> body = e2eeBody(clientMessageId, List.of(envelope(chatId, a1,
                a1.material(), b1, b1.material(), random(272), true)));
        UUID idempotencyKey = UUID.randomUUID();
        JsonNode first = send(fixture.alice(), a1, chatId, body, 201, idempotencyKey);

        deleteDevice(fixture.bob(), b1.id());

        // Idempotency-Key replay: same message, honest current coverage (peer_devices=0).
        JsonNode replay = send(fixture.alice(), a1, chatId, body, 201, idempotencyKey);
        CONTRACT.assertValid("MessageCreateResult", replay);
        assertThat(replay.get("id").asText()).isEqualTo(first.get("id").asText());
        assertThat(replay.get("seq").asLong()).isEqualTo(first.get("seq").asLong());
        JsonNode coverage = replay.get("envelope_coverage");
        assertThat(coverage.get("peer_devices").asInt()).isZero();
        assertThat(coverage.get("peer_covered").asInt()).isZero();
        assertThat(coverage.get("devices").asInt()).isZero();

        // client_message_id replay with a new Idempotency-Key has the same guarantee.
        JsonNode byClientId = send(fixture.alice(), a1, chatId, body, 201);
        CONTRACT.assertValid("MessageCreateResult", byClientId);
        assertThat(byClientId.get("id").asText()).isEqualTo(first.get("id").asText());
        assertThat(byClientId.get("envelope_coverage").get("peer_devices").asInt()).isZero();
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    @Test
    void concurrentClientMessageIdRaceStillCarriesCoverage() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());
        Map<String, Object> body = e2eeBody(UUID.randomUUID(), List.of(envelope(chatId, a1,
                a1.material(), b1, b1.material(), random(272), true)));
        SessionResponse alice = sessionFor(fixture.alice(), a1.id(),
                workspaceFor(chatId, fixture.alice()));

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<MvcResult>> futures = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                futures.add(pool.submit(() -> {
                    start.await(5, TimeUnit.SECONDS);
                    return mockMvc.perform(authed(
                                    post("/api/v1/chats/{id}/messages", chatId), alice, a1.id())
                                    .header("Idempotency-Key", UUID.randomUUID())
                                    .contentType(MediaType.APPLICATION_JSON)
                                    .content(objectMapper.writeValueAsString(body)))
                            .andReturn();
                }));
            }
            start.countDown();
            int created = 0;
            for (Future<MvcResult> future : futures) {
                MvcResult result = future.get(20, TimeUnit.SECONDS);
                int status = result.getResponse().getStatus();
                if (status == 201) {
                    created++;
                    JsonNode response = json(result);
                    assertThat(response.get("envelope_coverage"))
                            .as("E2EE 201 must carry envelope_coverage (D-S4-04)")
                            .isNotNull();
                    CONTRACT.assertValid("MessageCreateResult", response);
                } else {
                    assertThat(status).isEqualTo(409);
                }
            }
            assertThat(created).isGreaterThanOrEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    @Test
    void nonCanonicalUuidsAndDuplicateJsonKeysAreRejected() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());
        Map<String, Object> valid = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(272), true);

        Map<String, Object> lenientUuid = new LinkedHashMap<>(valid);
        lenientUuid.put("recipient_device_id", "1-1-1-1-1");
        JsonNode uuidError = expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(lenientUuid)), 422);
        assertThat(uuidError.get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");
        assertThat(uuidError.get("details").get("field").asText())
                .contains("recipient_device_id");

        Map<String, Object> upperCase = new LinkedHashMap<>(valid);
        upperCase.put("recipient_device_id", b1.id().toString().toUpperCase(Locale.ROOT));
        assertThat(expectError(fixture.alice(), a1, chatId,
                e2eeBody(UUID.randomUUID(), List.of(upperCase)), 422)
                .get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");

        // Duplicate JSON keys must not be last-wins.
        UUID clientMessageId = UUID.randomUUID();
        String serialized = objectMapper.writeValueAsString(e2eeBody(clientMessageId,
                List.of(valid)));
        String duplicated = serialized.replaceFirst("\\{",
                "{\"client_message_id\":\"" + clientMessageId + "\",");
        MvcResult duplicate = mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", chatId),
                        sessionFor(fixture.alice(), a1.id(), workspaceFor(chatId, fixture.alice())),
                        a1.id())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(duplicated))
                .andReturn();
        assertThat(duplicate.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(duplicate).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void legacyTargetAndMissingPeerEnvelopeAreRejected() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device a2 = register(fixture.alice(), "a2");
        Device b1 = register(fixture.bob(), "b1");
        UUID legacyBob = registerLegacy(fixture.bob(), "bob-legacy");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        // Legacy recipient: whole message rejected, no partial fan-out.
        Map<String, Object> toLegacy = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        toLegacy.put("recipient_device_id", legacyBob.toString());
        JsonNode legacy = expectError(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), b1, b1.material(),
                        random(300), true), toLegacy)), 422);
        assertThat(legacy.get("code").asText()).isEqualTo("E2EE_LEGACY_DEVICE");
        assertThat(legacy.get("details").get("field").asText())
                .isEqualTo("envelopes[1].recipient_device_id");

        // No envelope for the peer: 409 before any message/seq is created.
        JsonNode noPeer = expectError(fixture.alice(), a1, chatId, e2eeBody(
                UUID.randomUUID(), List.of(envelope(chatId, a1, a1.material(), a2,
                        a1.material(), random(300), true))), 409);
        assertThat(noPeer.get("code").asText()).isEqualTo("E2EE_NO_PEER_ENVELOPE");
        assertThat(messageCount(chatId)).isZero();

        // Self-envelope (current device) is rejected.
        JsonNode self = expectError(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), a1, a1.material(),
                        random(300), true))), 422);
        assertThat(self.get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");

        // An unknown (or non-participant) recipient device is never addressed.
        Map<String, Object> unknownRecipient = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        unknownRecipient.put("recipient_device_id", UUID.randomUUID().toString());
        JsonNode unknown = expectError(fixture.alice(), a1, chatId, e2eeBody(
                UUID.randomUUID(), List.of(unknownRecipient)), 422);
        assertThat(unknown.get("code").asText()).isEqualTo("UNKNOWN_DEVICE");
    }

    @Test
    void noActivePeerDevicesRejectsBeforeMessage() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        // Revoke the peer's only capable device: it is no longer a candidate.
        deleteDevice(fixture.bob(), b1.id());

        JsonNode error = expectError(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), b1, b1.material(),
                        random(300), true))), 409);
        assertThat(error.get("code").asText()).isEqualTo("E2EE_NO_ACTIVE_DEVICES");
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void cryptoIsReturnedOnlyToTheAddressedDevice() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device a2 = register(fixture.alice(), "a2");
        Device a3 = register(fixture.alice(), "a3");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        byte[] toBob = random(300);
        byte[] toA2 = random(300);
        JsonNode sent = send(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(), List.of(
                envelope(chatId, a1, a1.material(), b1, b1.material(), toBob, true),
                envelope(chatId, a1, a1.material(), a2, a1.material(), toA2,
                        false))), 201);
        UUID messageId = UUID.fromString(sent.get("id").asText());

        // Bob's device gets its envelope, no plaintext.
        JsonNode bobPage = list(fixture.bob(), b1, chatId);
        CONTRACT.assertValid("MessagePage", bobPage);
        JsonNode bobMessage = bobPage.get("items").get(0);
        CONTRACT.assertValid("Message", bobMessage);
        assertThat(bobMessage.get("id").asText()).isEqualTo(messageId.toString());
        assertThat(bobMessage.get("text").isNull()).isTrue();
        assertThat(bobMessage.get("reply_to_id").isNull()).isTrue();
        assertThat(bobMessage.get("client_message_id").asText())
                .isEqualTo(sent.get("client_message_id").asText());
        JsonNode bobCrypto = bobMessage.get("crypto");
        CONTRACT.assertValid("CryptoEnvelope", bobCrypto);
        assertThat(bobCrypto.get("recipient_device_id").asText()).isEqualTo(b1.id().toString());
        assertThat(bobCrypto.get("sender_device_id").asText()).isEqualTo(a1.id().toString());
        assertThat(Base64Url.decode(bobCrypto.get("ciphertext").asText()).orElseThrow())
                .isEqualTo(toBob);
        assertThat(bobCrypto.get("prekey").isNull()).isFalse();

        // Alice's second device gets only its own envelope.
        JsonNode a2Message = list(fixture.alice(), a2, chatId).get("items").get(0);
        assertThat(a2Message.get("crypto").get("recipient_device_id").asText())
                .isEqualTo(a2.id().toString());
        assertThat(Base64Url.decode(a2Message.get("crypto").get("ciphertext").asText())
                .orElseThrow()).isEqualTo(toA2);
        assertThat(a2Message.get("crypto").get("prekey").isNull()).isTrue();

        // A third device, the sender's current device and a legacy device see crypto:null.
        assertThat(list(fixture.alice(), a3, chatId).get("items").get(0).get("crypto").isNull())
                .isTrue();
        assertThat(list(fixture.alice(), a1, chatId).get("items").get(0).get("crypto").isNull())
                .isTrue();

        // The GET payload never exposes the other device's envelope or the envelope count.
        assertThat(bobPage.toString()).doesNotContain(a2.id().toString());
        assertThat(bobPage.toString()).doesNotContain("envelopes");
    }

    @Test
    void senderIdentityAndGenerationAreVerified() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        // Stale recipient generation.
        Map<String, Object> staleRecipient = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        staleRecipient.put("recipient_key_generation", 2);
        JsonNode keyChanged = expectError(fixture.alice(), a1, chatId, e2eeBody(
                UUID.randomUUID(), List.of(staleRecipient)), 409);
        assertThat(keyChanged.get("code").asText()).isEqualTo("KEY_CHANGED");

        // Stale sender generation.
        Map<String, Object> staleSender = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        staleSender.put("sender_key_generation", 2);
        assertThat(expectError(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(staleSender)), 409).get("code").asText()).isEqualTo("KEY_CHANGED");

        // prekey identity keys must match the registered device (P0-2b).
        Map<String, Object> wrongIdentity = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        @SuppressWarnings("unchecked")
        Map<String, Object> prekey = (Map<String, Object>) wrongIdentity.get("prekey");
        prekey.put("sender_identity_signing_key",
                Base64Url.encode(b1.material().identitySigningKey()));
        JsonNode identityMismatch = expectError(fixture.alice(), a1, chatId, e2eeBody(
                UUID.randomUUID(), List.of(wrongIdentity)), 422);
        assertThat(identityMismatch.get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");
        assertThat(identityMismatch.get("details").get("field").asText())
                .contains("prekey.sender_identity_signing_key");

        // Envelope sender must be the caller's X-Device-Id.
        Map<String, Object> wrongSender = envelope(chatId, a1, a1.material(), b1,
                b1.material(), random(300), true);
        wrongSender.put("sender_device_id", b1.id().toString());
        JsonNode senderMismatch = expectError(fixture.alice(), a1, chatId, e2eeBody(
                UUID.randomUUID(), List.of(wrongSender)), 422);
        assertThat(senderMismatch.get("code").asText()).isEqualTo("INVALID_ENVELOPE_FORMAT");

        // A legacy sender device cannot send E2EE at all.
        JsonNode legacySender = expectError(fixture.alice(), fixture.alice().device().id(),
                chatId, e2eeBody(UUID.randomUUID(), List.of(envelope(chatId, a1,
                        a1.material(), b1, b1.material(), random(300), true))), 422);
        assertThat(legacySender.get("code").asText()).isEqualTo("E2EE_LEGACY_DEVICE");

        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void idempotencyAndClientMessageIdSemantics() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());

        UUID clientMessageId = UUID.randomUUID();
        Map<String, Object> body = e2eeBody(clientMessageId, List.of(envelope(chatId, a1,
                a1.material(), b1, b1.material(), random(300), true)));
        UUID idempotencyKey = UUID.randomUUID();
        JsonNode first = send(fixture.alice(), a1, chatId, body, 201, idempotencyKey);
        JsonNode replay = send(fixture.alice(), a1, chatId, body, 201, idempotencyKey);
        assertThat(replay.get("id").asText()).isEqualTo(first.get("id").asText());
        assertThat(replay.get("seq").asLong()).isEqualTo(first.get("seq").asLong());
        assertThat(replay.get("envelope_coverage")).isNotNull();

        // Same client_message_id and exact same bytes, new Idempotency-Key -> replay.
        JsonNode byClientId = send(fixture.alice(), a1, chatId, body, 201);
        assertThat(byClientId.get("id").asText()).isEqualTo(first.get("id").asText());
        assertThat(byClientId.get("envelope_coverage")).isNotNull();

        // Same client_message_id with different ciphertext -> conflict.
        Map<String, Object> otherBytes = e2eeBody(clientMessageId, List.of(envelope(chatId, a1,
                a1.material(), b1, b1.material(), random(300), true)));
        JsonNode conflict = expectError(fixture.alice(), a1, chatId, otherBytes, 409);
        assertThat(conflict.get("code").asText()).isEqualTo("CLIENT_MESSAGE_ID_CONFLICT");

        // Another user reusing the id never replays the first user's message.
        JsonNode foreign = expectError(fixture.bob(), b1, chatId,
                e2eeBody(clientMessageId, List.of(envelope(chatId, b1, b1.material(), a1,
                        a1.material(), random(300), true))), 409);
        assertThat(foreign.get("code").asText()).isEqualTo("CLIENT_MESSAGE_ID_CONFLICT");

        // Exactly one message and one envelope set exist.
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM message.message_envelopes
                 WHERE message_id = ?
                """, Integer.class, UUID.fromString(first.get("id").asText()))).isEqualTo(1);
    }

    @Test
    void managedChatRejectsEnvelopeFieldWhenTheFlagIsOn() throws Exception {
        // The dev workspace is MANAGED: envelopes are an E2EE-only payload.
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice.workspace().id(), bob.user().id());
        Device a1 = register(alice, "managed-a1");
        Device b1 = register(bob, "managed-b1");
        UUID chatId = UUID.fromString(createDirect(alice, alice.workspace().id(),
                bob.user().id(), 201).get("id").asText());

        JsonNode error = expectError(alice, a1, chatId, e2eeBody(UUID.randomUUID(),
                List.of(envelope(chatId, a1, a1.material(), b1, b1.material(),
                        random(300), true))), 422);
        assertThat(error.get("code").asText()).isEqualTo("ENVELOPES_NOT_ALLOWED");
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void payloadLimitAndTenantIsolation() throws Exception {
        Fixture fixture = fixture();
        Device a1 = register(fixture.alice(), "a1");
        Device b1 = register(fixture.bob(), "b1");
        UUID chatId = UUID.fromString(createDirect(fixture.alice(), fixture.workspaceId(),
                fixture.bob().user().id(), 201).get("id").asText());
        send(fixture.alice(), a1, chatId, e2eeBody(UUID.randomUUID(), List.of(
                envelope(chatId, a1, a1.material(), b1, b1.material(), random(300),
                        true))), 201);

        // Wire limit is enforced before JSON parsing (512 KiB).
        String huge = "{\"client_message_id\":\"" + UUID.randomUUID()
                + "\",\"type\":\"TEXT\",\"envelopes\":[],\"pad\":\""
                + "x".repeat(600_000) + "\"}";
        MvcResult tooLarge = mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", chatId),
                        sessionFor(fixture.alice(), a1.id(), fixture.workspaceId()), a1.id())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(huge))
                .andExpect(status().isPayloadTooLarge())
                .andReturn();
        assertThat(json(tooLarge).get("code").asText()).isEqualTo("PAYLOAD_TOO_LARGE");
        assertThat(messageCount(chatId)).isEqualTo(1);

        // A non-member cannot read or write the chat.
        SessionResponse outsider = devSession();
        mockMvc.perform(authed(get("/api/v1/chats/{id}/messages", chatId), outsider))
                .andExpect(status().isNotFound());

        // Row-level security hides envelopes of another workspace even for the app role.
        UUID otherWorkspace = fixture.bob().workspace().id();
        assertThat(inTenant(fixture.alice().user().id(), otherWorkspace,
                () -> jdbc.queryForObject("SELECT count(*) FROM message.message_envelopes",
                        Integer.class))).isZero();

        // An insert with a foreign workspace_id is rejected by RLS, not silently stored.
        assertThatThrownBy(() -> inTenant(fixture.alice().user().id(), fixture.workspaceId(),
                () -> jdbc.update("""
                        INSERT INTO message.message_envelopes
                               (message_id, recipient_device_id, sender_device_id, workspace_id,
                                chat_id, scheme, sender_key_generation,
                                recipient_key_generation, session_id, header, ciphertext,
                                prekey, created_at)
                        VALUES (?, ?, ?, ?, ?, 'PAIRWISE_X3DH_DR', 1, 1,
                                CAST(? AS bytea), CAST('{}' AS jsonb), CAST(? AS bytea),
                                NULL, now())
                        """, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                        otherWorkspace, chatId, random(16), random(272))))
                .isInstanceOf(DataAccessException.class);
    }

    // ---------------------------------------------------------------------
    // Fixture and helpers
    // ---------------------------------------------------------------------

    /** One E2EE workspace with alice (owner) and bob (member), plus keyed devices. */
    private Fixture fixture() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        return new Fixture(alice, bob, workspaceId);
    }

    private record Fixture(SessionResponse alice, SessionResponse bob, UUID workspaceId) {
    }

    private record Device(UUID id, Material material) {
    }

    private UUID createE2eeWorkspace(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces"), owner)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "e2ee-" + UUID.randomUUID(),
                                "security_mode", "E2EE"))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void joinWorkspace(UUID workspaceId, UUID userId) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, workspaceId, userId);
    }

    private Device register(SessionResponse session, String name) throws Exception {
        Material material = DeviceKeyTestSupport.generate();
        MvcResult result = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + session.accessToken())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                material.registrationBody(name + "-" + UUID.randomUUID(),
                                        "0.7.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        return new Device(UUID.fromString(json(result).get("id").asText()), material);
    }

    private UUID registerLegacy(SessionResponse session, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + session.accessToken())
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", name + "-" + UUID.randomUUID(),
                                "platform", "WEB", "app_version", "0.7.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void deleteDevice(SessionResponse session, UUID deviceId) throws Exception {
        mockMvc.perform(authed(delete("/api/v1/devices/{id}", deviceId),
                        sessionFor(session, deviceId, session.workspace().id()))
                        .header("Idempotency-Key", UUID.randomUUID()))
                .andExpect(status().isNoContent());
    }

    private JsonNode createDirect(SessionResponse actor, UUID workspaceId, UUID peerId,
                                  int expected) throws Exception {
        return createDirectBody(actor, workspaceId, Map.of("type", "DIRECT",
                "peer_id", peerId.toString()), expected);
    }

    private JsonNode createDirectBody(SessionResponse actor, UUID workspaceId,
                                      Map<String, Object> body, int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/chats", workspaceId), actor)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is(expected))
                .andReturn();
        return json(result);
    }

    private Map<String, Object> e2eeBody(UUID clientMessageId,
                                         List<Map<String, Object>> envelopes) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", clientMessageId.toString());
        body.put("type", "TEXT");
        body.put("envelopes", envelopes);
        return body;
    }

    private Map<String, Object> envelope(UUID chatId, Device sender, Material senderKeys,
                                         Device recipient, Material recipientKeys,
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
                    Base64Url.encode(senderKeys.identitySigningKey()));
            block.put("sender_identity_dh_key", Base64Url.encode(senderKeys.identityDhKey()));
            block.put("sender_ephemeral_key", Base64Url.encode(random(32)));
            block.put("recipient_identity_dh_key",
                    Base64Url.encode(recipientKeys.identityDhKey()));
            block.put("spk_id", "spk-1");
            block.put("spk_public", Base64Url.encode(random(32)));
            block.put("opk_id", null);
            block.put("opk_public", null);
            block.put("signature", Base64Url.encode(random(64)));
            envelope.put("prekey", block);
        }
        return envelope;
    }

    private void assertPlaintext(SessionResponse session, Device device, UUID chatId,
                                 List<Map<String, Object>> envelopes, String field,
                                 Object value) throws Exception {
        Map<String, Object> body = e2eeBody(UUID.randomUUID(), envelopes);
        body.put(field, value);
        JsonNode error = expectError(session, device, chatId, body, 422);
        assertThat(error.get("code").asText()).isEqualTo("E2EE_PLAINTEXT_FORBIDDEN");
        assertThat(error.get("details").get("field").asText()).isEqualTo(field);
    }

    private JsonNode send(SessionResponse session, Device device, UUID chatId,
                          Map<String, Object> body, int expected) throws Exception {
        return send(session, device, chatId, body, expected, UUID.randomUUID());
    }

    private JsonNode send(SessionResponse session, Device device, UUID chatId,
                          Map<String, Object> body, int expected, UUID idempotencyKey)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", chatId),
                        sessionFor(session, device.id(), workspaceFor(chatId, session)),
                        device.id())
                        .header("Idempotency-Key", idempotencyKey)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(expected);
        return json(result);
    }

    private JsonNode expectError(SessionResponse session, Device device, UUID chatId,
                                 Object body, int expected) throws Exception {
        return expectError(session, device.id(), chatId, body, expected);
    }

    private JsonNode expectError(SessionResponse session, UUID deviceId, UUID chatId,
                                 Object body, int expected) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", chatId),
                        sessionFor(session, deviceId, workspaceFor(chatId, session)), deviceId)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(expected);
        return json(result);
    }

    private JsonNode list(SessionResponse session, Device device, UUID chatId)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/chats/{id}/messages", chatId),
                        sessionFor(session, device.id(), workspaceFor(chatId, session)),
                        device.id()))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private UUID workspaceFor(UUID chatId, SessionResponse fallback) {
        UUID workspaceId = migrator().queryForObject(
                "SELECT workspace_id FROM chat.chats WHERE id = ?", UUID.class, chatId);
        return workspaceId == null ? fallback.workspace().id() : workspaceId;
    }

    private SessionResponse sessionFor(SessionResponse session, UUID deviceId,
                                       UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), deviceId, workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                new SessionResponse.DeviceInfo(deviceId, "WEB"), session.workspace(),
                session.chat());
    }

    private MockHttpServletRequestBuilder authed(MockHttpServletRequestBuilder builder,
                                                 SessionResponse session, UUID deviceId) {
        return builder.header("Authorization", "Bearer " + session.accessToken())
                .header("X-Device-Id", deviceId.toString());
    }

    private static byte[] random(int size) {
        byte[] value = new byte[size];
        RANDOM.nextBytes(value);
        return value;
    }
}
