package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.notification.application.model.EmailNotification;
import ru.krug.backend.notification.application.model.MessageCreatedSignal;
import ru.krug.backend.notification.application.port.ChatDirectoryPort;
import ru.krug.backend.notification.application.port.NotificationSenderPort;
import ru.krug.backend.notification.application.usecase.NotifyUseCase;
import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.NotificationType;
import ru.krug.backend.notification.domain.repository.NotificationPreferenceRepository;
import ru.krug.backend.notification.domain.repository.NotificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

class NotifyUseCaseTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID MESSAGE = UUID.randomUUID();
    private static final UUID SENDER = UUID.randomUUID();
    private static final UUID RECIPIENT = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-16T12:00:00Z");

    private final TenantContext tenantContext = mock(TenantContext.class);
    private final NotificationRepository notifications = mock(NotificationRepository.class);
    private final NotificationPreferenceRepository preferences =
            mock(NotificationPreferenceRepository.class);
    private final ChatDirectoryPort chatDirectory = mock(ChatDirectoryPort.class);
    private final NotificationSenderPort sender = mock(NotificationSenderPort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private final NotifyUseCase useCase = new NotifyUseCase(tenantContext, notifications,
            preferences, chatDirectory, sender, clock);

    @Test
    void notifiesActiveMemberButNeverTheSender() {
        givenChat(List.of(SENDER, RECIPIENT));
        when(clock.now()).thenReturn(NOW);
        when(notifications.saveIfAbsent(any())).thenReturn(true);

        int created = useCase.notifyMessageCreated(signal());

        assertThat(created).isEqualTo(1);
        ArgumentCaptor<Notification> captor = ArgumentCaptor.forClass(Notification.class);
        verify(notifications).saveIfAbsent(captor.capture());
        Notification notification = captor.getValue();
        assertThat(notification.userId()).isEqualTo(RECIPIENT);
        assertThat(notification.body()).isNull();
        assertThat(notification.title()).isEqualTo("Новое сообщение");
        assertThat(notification.dedupeKey()).isEqualTo(RECIPIENT + ":" + CHAT + ":" + MESSAGE
                + ":MESSAGE");
        verify(sender, never()).send(any());
    }

    @Test
    void muteAndMentionsPreferencesSuppressTheNotification() {
        givenChat(List.of(RECIPIENT));
        when(clock.now()).thenReturn(NOW);
        when(preferences.findByUser(RECIPIENT)).thenReturn(List.of(preference(Mode.MUTE)));
        useCase.notifyMessageCreated(signal());
        verify(notifications, never()).saveIfAbsent(any());

        when(preferences.findByUser(RECIPIENT)).thenReturn(List.of(preference(Mode.MENTIONS)));
        useCase.notifyMessageCreated(signal());
        verify(notifications, never()).saveIfAbsent(any());
    }

    @Test
    void dedupeConflictSkipsEmailAsWell() {
        givenChat(List.of(RECIPIENT));
        when(clock.now()).thenReturn(NOW);
        when(preferences.findByUser(RECIPIENT)).thenReturn(List.of(preference(Mode.ALL),
                new NotificationPreference(RECIPIENT, WORKSPACE, null, NotificationType.MESSAGE,
                        Channel.EMAIL, Mode.ALL)));
        when(notifications.saveIfAbsent(any())).thenReturn(false);

        int created = useCase.notifyMessageCreated(signal());

        assertThat(created).isZero();
        verify(sender, never()).send(any());
    }

    @Test
    void emailAllSendsContentFreeDescriptor() {
        givenChat(List.of(RECIPIENT));
        when(clock.now()).thenReturn(NOW);
        when(preferences.findByUser(RECIPIENT)).thenReturn(List.of(preference(Mode.ALL),
                new NotificationPreference(RECIPIENT, WORKSPACE, null, NotificationType.MESSAGE,
                        Channel.EMAIL, Mode.ALL)));
        when(notifications.saveIfAbsent(any())).thenReturn(true);

        useCase.notifyMessageCreated(signal());

        ArgumentCaptor<EmailNotification> captor =
                ArgumentCaptor.forClass(EmailNotification.class);
        verify(sender).send(captor.capture());
        assertThat(captor.getValue().userId()).isEqualTo(RECIPIENT);
        assertThat(captor.getValue().type()).isEqualTo(NotificationType.MESSAGE);
    }

    @Test
    void emailFailureDoesNotBreakFanOut() {
        givenChat(List.of(RECIPIENT));
        when(clock.now()).thenReturn(NOW);
        when(preferences.findByUser(RECIPIENT)).thenReturn(List.of(preference(Mode.ALL),
                new NotificationPreference(RECIPIENT, WORKSPACE, null, NotificationType.MESSAGE,
                        Channel.EMAIL, Mode.ALL)));
        when(notifications.saveIfAbsent(any())).thenReturn(true);
        org.mockito.Mockito.doThrow(new IllegalStateException("provider down"))
                .when(sender).send(any());

        assertThat(useCase.notifyMessageCreated(signal())).isEqualTo(1);
    }

    private void givenChat(List<UUID> members) {
        when(chatDirectory.findChat(WORKSPACE, CHAT)).thenReturn(Optional.of(
                new ChatDirectoryPort.ChatDirectory(CHAT, WORKSPACE, "Общий чат", false,
                        members)));
    }

    private static NotificationPreference preference(Mode mode) {
        return new NotificationPreference(RECIPIENT, WORKSPACE, null, NotificationType.MESSAGE,
                Channel.IN_APP, mode);
    }

    private static MessageCreatedSignal signal() {
        return new MessageCreatedSignal(WORKSPACE, CHAT, MESSAGE, SENDER, NOW);
    }
}
