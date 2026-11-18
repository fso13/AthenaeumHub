package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.notification.application.model.NotificationPageCursor;
import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.NotificationType;
import ru.krug.backend.notification.domain.service.NotificationPreferencePolicy;

class NotificationDomainTest {

    private static final UUID USER = UUID.randomUUID();
    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID MESSAGE = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-16T12:00:00.123456Z");

    @Test
    void createsGenericBodyLessNotificationWithStableDedupeKey() {
        Notification notification = Notification.create(UUID.randomUUID(), USER, WORKSPACE, CHAT,
                NotificationType.MESSAGE, Notification.NEW_MESSAGE_TITLE,
                Notification.dedupeKey(USER, CHAT, MESSAGE, NotificationType.MESSAGE), NOW);

        assertThat(notification.title()).isEqualTo("Новое сообщение");
        assertThat(notification.body()).isNull();
        assertThat(notification.isRead()).isFalse();
        assertThat(notification.dedupeKey())
                .isEqualTo(USER + ":" + CHAT + ":" + MESSAGE + ":MESSAGE");
    }

    @Test
    void markReadIsIdempotentAndPreservesTheFirstTimestamp() {
        Notification notification = Notification.create(UUID.randomUUID(), USER, WORKSPACE, CHAT,
                NotificationType.MESSAGE, Notification.NEW_MESSAGE_TITLE,
                Notification.dedupeKey(USER, CHAT, MESSAGE, NotificationType.MESSAGE), NOW);
        Instant firstRead = NOW.plusSeconds(10);

        Notification read = notification.markRead(firstRead);

        assertThat(read.isRead()).isTrue();
        assertThat(read.readAt()).isEqualTo(firstRead);
        assertThat(read.markRead(NOW.plusSeconds(60)).readAt()).isEqualTo(firstRead);
    }

    @Test
    void modeSemantics() {
        assertThat(Mode.ALL.allows(NotificationType.MESSAGE)).isTrue();
        assertThat(Mode.MUTE.allows(NotificationType.MESSAGE)).isFalse();
        assertThat(Mode.MENTIONS.allows(NotificationType.MESSAGE)).isFalse();
        assertThat(Mode.MENTIONS.allows(NotificationType.MENTION)).isTrue();
    }

    @Test
    void chatScopedPreferenceOverridesGlobalAndChannelDefaultsApply() {
        List<NotificationPreference> preferences = List.of(
                new NotificationPreference(USER, WORKSPACE, null, NotificationType.MESSAGE,
                        Channel.IN_APP, Mode.MUTE),
                new NotificationPreference(USER, WORKSPACE, CHAT, NotificationType.MESSAGE,
                        Channel.IN_APP, Mode.ALL));

        assertThat(NotificationPreferencePolicy.resolve(preferences, WORKSPACE, CHAT,
                NotificationType.MESSAGE, Channel.IN_APP)).isEqualTo(Mode.ALL);
        assertThat(NotificationPreferencePolicy.resolve(preferences, WORKSPACE, UUID.randomUUID(),
                NotificationType.MESSAGE, Channel.IN_APP)).isEqualTo(Mode.MUTE);
        assertThat(NotificationPreferencePolicy.resolve(List.of(), WORKSPACE, CHAT,
                NotificationType.MESSAGE, Channel.IN_APP)).isEqualTo(Mode.ALL);
        // Email is opt-in for the E6 dev stub.
        assertThat(NotificationPreferencePolicy.resolve(List.of(), WORKSPACE, CHAT,
                NotificationType.MESSAGE, Channel.EMAIL)).isEqualTo(Mode.MUTE);
        // A workspace-global mute must not leak into another workspace.
        assertThat(NotificationPreferencePolicy.resolve(preferences, UUID.randomUUID(), CHAT,
                NotificationType.MESSAGE, Channel.IN_APP)).isEqualTo(Mode.ALL);
    }

    @Test
    void cursorRoundTripsMicrosecondTimestamps() {
        UUID id = UUID.randomUUID();
        NotificationPageCursor cursor = new NotificationPageCursor(NOW, id);

        NotificationPageCursor decoded = NotificationPageCursor.decode(cursor.encode());

        assertThat(decoded.createdAt()).isEqualTo(NOW);
        assertThat(decoded.id()).isEqualTo(id);
    }
}
