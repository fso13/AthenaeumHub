package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.Test;

import ru.krug.backend.realtime.application.model.CallKind;
import ru.krug.backend.realtime.application.model.CallSignal;
import ru.krug.backend.realtime.application.model.CallSignalRelay;
import ru.krug.backend.realtime.application.model.EphemeralEvent;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.RealtimeEvent;
import ru.krug.backend.realtime.application.model.RealtimeGap;
import ru.krug.backend.realtime.application.model.SubscribedChat;
import ru.krug.backend.realtime.application.service.RealtimeEventFactory;
import ru.krug.backend.realtime.infrastructure.ws.WsFrameCodec;
import ru.krug.backend.support.WsFrameContract;

/** Executable contract check for every WS protocol v1 frame. */
class RealtimeFrameContractTest {

    private static final Instant NOW = Instant.parse("2026-11-16T10:00:00Z");

    private final ObjectMapper mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private final WsFrameCodec codec = new WsFrameCodec(mapper);
    private final UUID workspaceId = UUID.randomUUID();
    private final UUID chatId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();

    @Test
    void helloMatchesContract() throws Exception {
        WsFrameContract.assertValid("hello",
                codec.hello("ws_01J", NOW, 25_000));
    }

    @Test
    void subscribedMatchesContractForAcceptedAndForbiddenChats() throws Exception {
        String frame = codec.subscribed(List.of(SubscribedChat.accepted(chatId, 42),
                SubscribedChat.forbidden(UUID.randomUUID())));

        WsFrameContract.assertValid("subscribed", frame);
        JsonNode node = mapper.readTree(frame);
        assertThat(node.get("chats").get(0).get("accepted").asBoolean()).isTrue();
        assertThat(node.get("chats").get(1).get("reason").asText()).isEqualTo("FORBIDDEN");
    }

    @Test
    void messageCreatedEventMatchesContractAndKeepsStableEventId() throws Exception {
        UUID messageId = UUID.randomUUID();
        MessageSnapshot snapshot = new MessageSnapshot(workspaceId, messageId, chatId, 7,
                "TEXT", userId, "Test", "hello", null, NOW, null, null, 1, null, null, List.of());
        RealtimeEvent event = RealtimeEventFactory.messageCreated(snapshot);

        String frame = codec.event(event);
        WsFrameContract.assertValid("event", frame);
        JsonNode node = mapper.readTree(frame);
        assertThat(node.get("event").asText()).isEqualTo("message.created");
        assertThat(node.get("event_id").asText()).isEqualTo(messageId.toString());
        assertThat(node.get("seq").asLong()).isEqualTo(7);
        assertThat(node.get("payload").get("id").asText()).isEqualTo(messageId.toString());
        assertThat(node.get("payload").get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(node.get("payload").get("text").asText()).isEqualTo("hello");
        assertThat(node.get("payload").get("version").asInt()).isEqualTo(1);
    }

    @Test
    void receiptEventMatchesContract() throws Exception {
        RealtimeEvent event = RealtimeEventFactory.messageReceipt(workspaceId, chatId, userId,
                11, NOW);

        WsFrameContract.assertValid("event", codec.event(event));
        JsonNode payload = mapper.readTree(codec.event(event)).get("payload");
        assertThat(payload.get("user_id").asText()).isEqualTo(userId.toString());
        assertThat(payload.get("last_read_seq").asLong()).isEqualTo(11);
    }

    @Test
    void ephemeralTypingAndPresenceHaveNoSeqOrEventId() throws Exception {
        EphemeralEvent typing = RealtimeEventFactory.typing(workspaceId, chatId, userId,
                NOW.plusSeconds(5), NOW);
        String typingFrame = codec.ephemeral(typing);
        WsFrameContract.assertValid("ephemeralEvent", typingFrame);
        JsonNode node = mapper.readTree(typingFrame);
        assertThat(node.get("event").asText()).isEqualTo("typing");
        assertThat(node.has("seq")).isFalse();
        assertThat(node.has("event_id")).isFalse();
        assertThat(node.get("payload").get("expires_at").asText())
                .isEqualTo(NOW.plusSeconds(5).toString());

        String presenceFrame = codec.ephemeral(RealtimeEventFactory.presence(workspaceId,
                chatId, userId, ru.krug.backend.realtime.application.model.PresenceStatus.ONLINE,
                NOW));
        WsFrameContract.assertValid("ephemeralEvent", presenceFrame);
        assertThat(mapper.readTree(presenceFrame).get("payload").get("status").asText())
                .isEqualTo("ONLINE");
    }

    @Test
    void gapPongErrorAndRevokedMatchContract() throws Exception {
        WsFrameContract.assertValid("resumeGap", codec.gap(
                RealtimeGap.retentionWindow(chatId, 0, 700)));
        WsFrameContract.assertValid("pong", codec.pong(NOW));
        WsFrameContract.assertValid("error", codec.error("WS_FRAME_INVALID", "bad",
                "req_1", chatId));
        WsFrameContract.assertValid("sessionRevoked", codec.sessionRevoked("DEVICE_REVOKED"));
    }

    @Test
    void callSignalMatchesContractAndCarriesNoSeqOrEventId() throws Exception {
        UUID callId = UUID.randomUUID();
        UUID fromDeviceId = UUID.randomUUID();
        CallSignal signal = new CallSignal(callId, CallKind.OFFER, true,
                "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n", null);
        CallSignalRelay relay = new CallSignalRelay(workspaceId, chatId, Set.of(userId),
                userId, fromDeviceId, signal, NOW);

        String frame = codec.callSignal(relay);
        WsFrameContract.assertValid("callSignal", frame);
        JsonNode node = mapper.readTree(frame);
        assertThat(node.get("type").asText()).isEqualTo("event");
        assertThat(node.get("event").asText()).isEqualTo("call.signal");
        assertThat(node.has("seq")).isFalse();
        assertThat(node.has("event_id")).isFalse();
        JsonNode payload = node.get("payload");
        assertThat(payload.get("call_id").asText()).isEqualTo(callId.toString());
        assertThat(payload.get("kind").asText()).isEqualTo("offer");
        assertThat(payload.get("video").asBoolean()).isTrue();
        assertThat(node.get("from_user_id").asText()).isEqualTo(userId.toString());
        assertThat(node.get("from_device_id").asText()).isEqualTo(fromDeviceId.toString());
        assertThat(payload.get("sdp").asText()).contains("v=0");
    }

    @Test
    void callUnavailableMatchesContractAndCarriesNoSeqOrEventId() throws Exception {
        UUID callId = UUID.randomUUID();
        String frame = codec.callUnavailable(workspaceId, chatId, callId, CallKind.OFFER,
                "PEER_OFFLINE", NOW);
        WsFrameContract.assertValid("callUnavailable", frame);
        JsonNode node = mapper.readTree(frame);
        assertThat(node.get("event").asText()).isEqualTo("call.unavailable");
        assertThat(node.has("seq")).isFalse();
        assertThat(node.has("event_id")).isFalse();
        assertThat(node.get("payload").get("reason").asText()).isEqualTo("PEER_OFFLINE");
        assertThat(node.get("payload").get("call_id").asText()).isEqualTo(callId.toString());
    }

    @Test
    void callSignalToStringNeverLeaksSdpOrCandidate() {
        CallSignal signal = new CallSignal(UUID.randomUUID(), CallKind.ICE, false, null,
                Map.of("candidate", "candidate:1 1 UDP 1 203.0.113.7 5000 typ host"));

        assertThat(signal.toString()).contains("<redacted>");
        assertThat(signal.toString()).doesNotContain("203.0.113.7");
        assertThat(signal.toString()).doesNotContain("candidate:1");
    }

    @Test
    void callErrorCarriesSemanticStatus() throws Exception {
        String frame = codec.error("CALL_NOT_SUPPORTED", "Calls are supported only in DIRECT",
                "ws_1", chatId, 422);

        WsFrameContract.assertValid("error", frame);
        assertThat(mapper.readTree(frame).get("status").asInt()).isEqualTo(422);
    }

    @Test
    void messageCreatedPayloadIncludesAttachmentsFromOpenApiMessage() throws Exception {
        UUID messageId = UUID.randomUUID();
        MessageSnapshot snapshot = new MessageSnapshot(workspaceId, messageId, chatId, 8,
                "TEXT", userId, "Test", null, null, NOW, null, null, 1, null, null,
                List.of(new ru.krug.backend.realtime.application.model.AttachmentSnapshot(
                        UUID.randomUUID(), "song.mp3", 1024, "audio/mpeg", "CLEAN",
                        new ru.krug.backend.realtime.application.model.AttachmentMediaSnapshot(
                                "AUDIO", 245_000L, null, null, "Song", "Artist", "Album",
                                "2024", "Rock", "https://example.com/cover.jpg", "ID3"))));
        RealtimeEvent event = RealtimeEventFactory.messageCreated(snapshot);

        String frame = codec.event(event);
        WsFrameContract.assertValid("event", frame);

        com.fasterxml.jackson.databind.JsonNode node = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(frame);
        com.fasterxml.jackson.databind.JsonNode attachments =
                node.get("payload").get("attachments");
        assertThat(attachments).isNotNull();
        assertThat(attachments.size()).isEqualTo(1);
        assertThat(attachments.get(0).get("filename").asText()).isEqualTo("song.mp3");
        assertThat(attachments.get(0).get("scan_status").asText()).isEqualTo("CLEAN");
        com.fasterxml.jackson.databind.JsonNode media = attachments.get(0).get("media");
        assertThat(media.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(media.get("duration_ms").asLong()).isEqualTo(245_000L);
        assertThat(media.get("title").asText()).isEqualTo("Song");
        assertThat(media.get("artwork_url").asText())
                .isEqualTo("https://example.com/cover.jpg");
        assertThat(media.get("metadata_source").asText()).isEqualTo("ID3");
    }

    @Test
    void gatewayPayloadMapAllowsNullFieldsFromOpenApiMessage() {
        MessageSnapshot system = new MessageSnapshot(workspaceId, UUID.randomUUID(), chatId, 1,
                "SYSTEM", null, null, null, null, NOW, null, null, 1, null, null, List.of());

        RealtimeEvent event = RealtimeEventFactory.messageCreated(system);

        assertThat(event.payload()).containsEntry("sender_id", null);
        assertThat(event.payload()).containsEntry("text", null);
    }
}
