package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.realtime.application.model.ChatSubscription;
import ru.krug.backend.realtime.application.model.EphemeralEvent;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.PresenceStatus;
import ru.krug.backend.realtime.application.model.RealtimeChatAccess;
import ru.krug.backend.realtime.application.model.RealtimeEvent;
import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.model.ReplayBatch;
import ru.krug.backend.realtime.application.model.SubscribedChat;
import ru.krug.backend.realtime.application.model.SubscriptionPlan;
import ru.krug.backend.realtime.application.port.RealtimeChatAccessPort;
import ru.krug.backend.realtime.application.port.RealtimeChatHistoryPort;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.application.usecase.SubscriptionService;
import ru.krug.backend.realtime.domain.exception.RealtimeSessionRevokedException;
import ru.krug.backend.realtime.domain.exception.SubscriptionLimitExceededException;
import ru.krug.backend.shared.application.port.ClockPort;

class SubscriptionServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-16T10:00:00Z");
    private static final int REPLAY_LIMIT = 500;
    private static final int MAX_SUBSCRIPTIONS = 200;

    private final UUID workspaceId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();
    private final UUID deviceId = UUID.randomUUID();
    private final UUID chatId = UUID.randomUUID();
    private final RealtimeSession session = RealtimeSession.open(userId, deviceId, workspaceId,
            NOW);

    private FakeAccess access;
    private FakeHistory history;
    private FakePublisher publisher;
    private FakeDevice device;
    private SubscriptionService service;

    @BeforeEach
    void setUp() {
        access = new FakeAccess();
        history = new FakeHistory();
        publisher = new FakePublisher();
        device = new FakeDevice();
        service = new SubscriptionService(access, history, publisher, device,
                new FakeSettings(), (ClockPort) () -> NOW);
    }

    @Test
    void subscribesAcceptedChatAndReplaysInSeqOrderWithoutDuplicates() {
        access.accept(chatId, 3);
        history.set(chatId, List.of(snapshot(3), snapshot(1), snapshot(2), snapshot(2)));

        SubscriptionPlan plan = service.subscribe(session,
                List.of(new ChatSubscription(chatId, 0)), true);

        assertThat(plan.sessionId()).isEqualTo(session.sessionId());
        assertThat(plan.presence()).isTrue();
        assertThat(plan.chats()).containsExactly(SubscribedChat.accepted(chatId, 3));
        ReplayBatch batch = plan.replays().get(0);
        assertThat(batch.gap()).isNull();
        assertThat(batch.events()).extracting(RealtimeEvent::seq)
                .containsExactly(1L, 2L, 3L);
    }

    @Test
    void forbiddenChatIsReportedWithoutLeakingData() {
        SubscriptionPlan plan = service.subscribe(session,
                List.of(new ChatSubscription(chatId, 0)), false);

        assertThat(plan.chats()).containsExactly(SubscribedChat.forbidden(chatId));
        assertThat(plan.replays()).isEmpty();
        assertThat(history.calls).isEmpty();
    }

    @Test
    void gapOutsideReplayWindowProducesResumeGapAndTailWindow() {
        access.accept(chatId, 1200);
        List<MessageSnapshot> rows = new ArrayList<>();
        for (long seq = 701; seq <= 1200; seq++) {
            rows.add(snapshot(seq));
        }
        history.set(chatId, rows);

        SubscriptionPlan plan = service.subscribe(session,
                List.of(new ChatSubscription(chatId, 0)), false);

        ReplayBatch batch = plan.replays().get(0);
        assertThat(batch.gap()).isNotNull();
        assertThat(batch.gap().fromSeq()).isZero();
        assertThat(batch.gap().toSeq()).isEqualTo(700);
        assertThat(batch.gap().reason()).isEqualTo("RETENTION_WINDOW");
        assertThat(batch.events()).hasSize(REPLAY_LIMIT);
        assertThat(batch.events().get(0).seq()).isEqualTo(701);
        assertThat(batch.events().get(REPLAY_LIMIT - 1).seq()).isEqualTo(1200);
        assertThat(history.calls).containsExactly(700L);
    }

    @Test
    void rejectsMoreThanTwoHundredChats() {
        List<ChatSubscription> requests = new ArrayList<>();
        for (int i = 0; i < MAX_SUBSCRIPTIONS + 1; i++) {
            requests.add(new ChatSubscription(UUID.randomUUID(), 0));
        }

        assertThatThrownBy(() -> service.subscribe(session, requests, false))
                .isInstanceOf(SubscriptionLimitExceededException.class);
    }

    @Test
    void deduplicatesRepeatedChatRequestsUsingTheHighestLastSeq() {
        access.accept(chatId, 10);
        List<MessageSnapshot> rows = new ArrayList<>();
        for (long seq = 6; seq <= 10; seq++) {
            rows.add(snapshot(seq));
        }
        history.set(chatId, rows);

        SubscriptionPlan plan = service.subscribe(session, List.of(
                new ChatSubscription(chatId, 1),
                new ChatSubscription(chatId, 5)), false);

        assertThat(plan.chats()).hasSize(1);
        assertThat(plan.replays()).hasSize(1);
        assertThat(plan.replays().get(0).events().get(0).seq()).isEqualTo(6);
        assertThat(history.calls).containsExactly(5L);
    }

    @Test
    void typingIsEphemeralAndHasFiveSecondTtl() {
        access.accept(chatId, 0);

        service.typing(session, chatId);

        assertThat(publisher.ephemeral).hasSize(1);
        EphemeralEvent event = publisher.ephemeral.get(0);
        assertThat(event.event()).isEqualTo("typing");
        assertThat(event.chatId()).isEqualTo(chatId);
        assertThat(event.payload().get("user_id")).isEqualTo(userId);
        assertThat(event.payload().get("expires_at")).isEqualTo(NOW.plusSeconds(5));
        assertThat(publisher.excludeSessionId).isEqualTo(session.sessionId());
    }

    @Test
    void typingForForeignChatIsSilentlyIgnored() {
        service.typing(session, chatId);

        assertThat(publisher.ephemeral).isEmpty();
    }

    @Test
    void presenceIsEphemeralAndMembershipChecked() {
        UUID secondChat = UUID.randomUUID();
        access.accept(chatId, 0);
        access.accept(secondChat, 0);

        service.presence(session, List.of(chatId, secondChat), PresenceStatus.ONLINE);

        assertThat(publisher.ephemeral).hasSize(2);
        assertThat(publisher.ephemeral).allSatisfy(event -> {
            assertThat(event.event()).isEqualTo("presence");
            assertThat(event.payload().get("status")).isEqualTo("ONLINE");
        });
    }

    @Test
    void revokedDeviceInvalidatesTheSession() {
        device.active = false;

        assertThatThrownBy(() -> service.subscribe(session,
                List.of(new ChatSubscription(chatId, 0)), false))
                .isInstanceOf(RealtimeSessionRevokedException.class);
    }

    private MessageSnapshot snapshot(long seq) {
        return new MessageSnapshot(workspaceId, UUID.randomUUID(), chatId, seq, "TEXT", userId,
                "User", "text-" + seq, null, NOW, null, null, 1, null, null, List.of());
    }

    private static final class FakeAccess implements RealtimeChatAccessPort {

        private final Map<UUID, RealtimeChatAccess> access = new HashMap<>();

        void accept(UUID chatId, long lastSeq) {
            access.put(chatId, RealtimeChatAccess.accepted(UUID.randomUUID(), lastSeq));
        }

        @Override
        public RealtimeChatAccess check(UUID workspaceId, UUID chatId, UUID userId,
                                        String requestId) {
            RealtimeChatAccess result = access.get(chatId);
            if (result == null) {
                return RealtimeChatAccess.forbidden(null);
            }
            return RealtimeChatAccess.accepted(workspaceId, result.lastSeq());
        }
    }

    private static final class FakeHistory implements RealtimeChatHistoryPort {

        private final Map<UUID, List<MessageSnapshot>> messages = new HashMap<>();
        private final List<Long> calls = new ArrayList<>();

        void set(UUID chatId, List<MessageSnapshot> rows) {
            messages.put(chatId, rows);
        }

        @Override
        public List<MessageSnapshot> after(UUID workspaceId, UUID chatId, UUID userId,
                                           UUID deviceId, long afterSeq, int limit) {
            calls.add(afterSeq);
            return messages.getOrDefault(chatId, List.of()).stream()
                    .filter(message -> message.seq() > afterSeq)
                    .sorted((left, right) -> Long.compare(left.seq(), right.seq()))
                    .limit(limit)
                    .toList();
        }
    }

    private static final class FakePublisher implements RealtimePublisherPort {

        private final List<RealtimeEvent> events = new ArrayList<>();
        private final List<EphemeralEvent> ephemeral = new ArrayList<>();
        private String excludeSessionId;

        @Override
        public void publish(RealtimeEvent event) {
            events.add(event);
        }

        @Override
        public void publishEphemeral(EphemeralEvent event, String excludeSessionId) {
            this.ephemeral.add(event);
            this.excludeSessionId = excludeSessionId;
        }

        @Override
        public void publishKeyChanged(UUID workspaceId, UUID chatId, String reason,
                                      UUID deviceId, Integer keyGeneration,
                                      java.time.Instant occurredAt) {
        }

        @Override
        public void publishDeviceListChanged(UUID userId, UUID deviceId, String status,
                                             int keyGeneration, java.time.Instant occurredAt) {
        }

        @Override
        public void publishSessionRevoked(UUID userId, UUID deviceId, String reason) {
        }

        @Override
        public void publishUserSessionsRevoked(UUID userId, String reason) {
        }
    }

    private static final class FakeDevice implements RealtimeDevicePort {

        private boolean active = true;

        @Override
        public boolean isActiveDeviceOfUser(UUID deviceId, UUID userId) {
            return active;
        }
    }

    private static final class FakeSettings implements RealtimeSettingsPort {

        @Override
        public String wsUrl() {
            return "ws://localhost:8081/ws";
        }

        @Override
        public Duration ticketTtl() {
            return Duration.ofSeconds(30);
        }

        @Override
        public int maxSubscriptions() {
            return MAX_SUBSCRIPTIONS;
        }

        @Override
        public int replayLimit() {
            return REPLAY_LIMIT;
        }

        @Override
        public int outboundQueueCapacity() {
            return 256;
        }

        @Override
        public Duration heartbeatInterval() {
            return Duration.ofSeconds(25);
        }

        @Override
        public Duration heartbeatTimeout() {
            return Duration.ofSeconds(60);
        }

        @Override
        public Duration typingTtl() {
            return Duration.ofSeconds(5);
        }

        @Override
        public Duration presenceTtl() {
            return Duration.ofSeconds(60);
        }

        @Override
        public int callSignalLimit() {
            return 10;
        }

        @Override
        public Duration callSignalWindow() {
            return Duration.ofSeconds(10);
        }

        @Override
        public int callSdpMaxBytes() {
            return 8192;
        }

        @Override
        public int callCandidateMaxBytes() {
            return 4096;
        }
    }
}
