package ru.krug.backend.realtime.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.realtime.application.model.ChatSubscription;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.PresenceStatus;
import ru.krug.backend.realtime.application.model.RealtimeChatAccess;
import ru.krug.backend.realtime.application.model.RealtimeEvent;
import ru.krug.backend.realtime.application.model.RealtimeGap;
import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.model.ReplayBatch;
import ru.krug.backend.realtime.application.model.SubscribedChat;
import ru.krug.backend.realtime.application.model.SubscriptionPlan;
import ru.krug.backend.realtime.application.port.RealtimeChatAccessPort;
import ru.krug.backend.realtime.application.port.RealtimeChatHistoryPort;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.application.service.RealtimeEventFactory;
import ru.krug.backend.realtime.domain.exception.RealtimeSessionRevokedException;
import ru.krug.backend.realtime.domain.exception.SubscriptionLimitExceededException;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Authorises subscriptions, builds the bounded replay window, and emits ephemeral
 * typing/presence. The hub itself owns the atomic replay+register step.
 */
@Service
public class SubscriptionService {

    private final RealtimeChatAccessPort chatAccess;
    private final RealtimeChatHistoryPort chatHistory;
    private final RealtimePublisherPort publisher;
    private final RealtimeDevicePort devicePort;
    private final RealtimeSettingsPort settings;
    private final ClockPort clock;

    public SubscriptionService(RealtimeChatAccessPort chatAccess,
                               RealtimeChatHistoryPort chatHistory,
                               RealtimePublisherPort publisher,
                               RealtimeDevicePort devicePort,
                               RealtimeSettingsPort settings,
                               ClockPort clock) {
        this.chatAccess = chatAccess;
        this.chatHistory = chatHistory;
        this.publisher = publisher;
        this.devicePort = devicePort;
        this.settings = settings;
        this.clock = clock;
    }

    public SubscriptionPlan subscribe(RealtimeSession session,
                                      List<ChatSubscription> requested, boolean presence) {
        requireActiveDevice(session);
        if (requested == null) {
            requested = List.of();
        }

        Map<UUID, ChatSubscription> unique = new LinkedHashMap<>();
        for (ChatSubscription subscription : requested) {
            unique.merge(subscription.chatId(), subscription,
                    (left, right) -> left.lastSeq() >= right.lastSeq() ? left : right);
        }
        if (unique.size() > settings.maxSubscriptions()) {
            throw new SubscriptionLimitExceededException(settings.maxSubscriptions());
        }

        List<SubscribedChat> chats = new ArrayList<>();
        List<ReplayBatch> replays = new ArrayList<>();
        for (ChatSubscription subscription : unique.values()) {
            UUID chatId = subscription.chatId();
            RealtimeChatAccess access = chatAccess.check(session.workspaceId(), chatId,
                    session.userId(), "realtime:" + session.sessionId());
            if (!access.accepted()) {
                chats.add(SubscribedChat.forbidden(chatId));
                continue;
            }
            chats.add(SubscribedChat.accepted(chatId, access.lastSeq()));
            replays.add(replay(session, access, subscription));
        }
        return new SubscriptionPlan(session.sessionId(), chats, replays, presence);
    }

    private ReplayBatch replay(RealtimeSession session, RealtimeChatAccess access,
                               ChatSubscription subscription) {
        UUID chatId = subscription.chatId();
        long maxSeq = access.lastSeq();
        long afterSeq = subscription.lastSeq();
        RealtimeGap gap = null;
        int limit = settings.replayLimit();
        if (maxSeq - afterSeq > limit) {
            long toSeq = maxSeq - limit;
            gap = RealtimeGap.retentionWindow(chatId, afterSeq, toSeq);
            afterSeq = toSeq;
        }

        long effectiveAfter = afterSeq;
        List<MessageSnapshot> rows = chatHistory.after(access.workspaceId(), chatId,
                session.userId(), session.deviceId(), effectiveAfter, limit);
        Map<Long, MessageSnapshot> ordered = new LinkedHashMap<>();
        rows.stream()
                .filter(row -> row.seq() > effectiveAfter)
                .sorted((left, right) -> Long.compare(left.seq(), right.seq()))
                .forEach(row -> ordered.putIfAbsent(row.seq(), row));
        List<RealtimeEvent> events = ordered.values().stream()
                .limit(limit)
                .map(RealtimeEventFactory::messageCreated)
                .toList();
        return new ReplayBatch(chatId, events, gap);
    }

    /** Client typing signal: membership-checked, TTL 5 s, never persisted. */
    public void typing(RealtimeSession session, UUID chatId) {
        requireActiveDevice(session);
        RealtimeChatAccess access = chatAccess.check(session.workspaceId(), chatId,
                session.userId(), "realtime:" + session.sessionId());
        if (!access.accepted()) {
            return;
        }
        Instant now = clock.now();
        publisher.publishEphemeral(RealtimeEventFactory.typing(access.workspaceId(), chatId,
                session.userId(), now.plus(settings.typingTtl()), now), session.sessionId());
    }

    /** Presence is ephemeral, membership-checked, and never replayed. */
    public void presence(RealtimeSession session, Iterable<UUID> chatIds,
                         PresenceStatus status) {
        requireActiveDevice(session);
        Instant now = clock.now();
        for (UUID chatId : chatIds) {
            RealtimeChatAccess access = chatAccess.check(session.workspaceId(), chatId,
                    session.userId(), "realtime:" + session.sessionId());
            if (!access.accepted()) {
                continue;
            }
            publisher.publishEphemeral(RealtimeEventFactory.presence(access.workspaceId(),
                    chatId, session.userId(), status, now), session.sessionId());
        }
    }

    private void requireActiveDevice(RealtimeSession session) {
        if (!devicePort.isActiveDeviceOfUser(session.deviceId(), session.userId())) {
            throw new RealtimeSessionRevokedException("DEVICE_REVOKED");
        }
    }
}
