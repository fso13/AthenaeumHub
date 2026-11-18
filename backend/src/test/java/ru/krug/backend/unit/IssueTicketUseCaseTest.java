package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import ru.krug.backend.realtime.application.model.IssuedRealtimeTicket;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.application.usecase.IssueTicketUseCase;
import ru.krug.backend.realtime.domain.exception.RealtimeForbiddenException;
import ru.krug.backend.realtime.domain.exception.RealtimeTicketInvalidException;
import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.repository.RealtimeTicketRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.ErrorCategory;

@ExtendWith(MockitoExtension.class)
class IssueTicketUseCaseTest {

    private static final Instant NOW = Instant.parse("2026-11-16T10:00:00Z");

    @Mock
    private RealtimeTicketRepository ticketRepository;
    @Mock
    private RealtimeDevicePort devicePort;
    @Mock
    private RealtimeSettingsPort settings;
    @Mock
    private ClockPort clock;

    private IssueTicketUseCase useCase;
    private final UUID userId = UUID.randomUUID();
    private final UUID deviceId = UUID.randomUUID();
    private final UUID workspaceId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        useCase = new IssueTicketUseCase(ticketRepository, devicePort, settings, clock);
    }

    @Test
    void issuesOpaqueTicketBoundToUserDeviceAndWorkspace() {
        when(devicePort.isActiveDeviceOfUser(deviceId, userId)).thenReturn(true);
        when(clock.now()).thenReturn(NOW);
        when(settings.ticketTtl()).thenReturn(Duration.ofSeconds(30));
        when(settings.wsUrl()).thenReturn("ws://localhost:8081/ws");

        IssuedRealtimeTicket issued = useCase.issue(
                new Principal(userId, deviceId, workspaceId, "req"), deviceId.toString());

        assertThat(issued.ticket()).hasSize(43);
        assertThat(issued.expiresAt()).isEqualTo(NOW.plusSeconds(30));
        assertThat(issued.wsUrl()).isEqualTo("ws://localhost:8081/ws");

        ArgumentCaptor<RealtimeTicket> saved = ArgumentCaptor.forClass(RealtimeTicket.class);
        verify(ticketRepository).save(saved.capture());
        assertThat(saved.getValue().userId()).isEqualTo(userId);
        assertThat(saved.getValue().deviceId()).isEqualTo(deviceId);
        assertThat(saved.getValue().workspaceId()).isEqualTo(workspaceId);
        assertThat(saved.getValue().tokenHash().value()).hasSize(64);
        assertThat(saved.getValue().tokenHash().value()).doesNotContain(issued.ticket());
    }

    @Test
    void missingDeviceHeaderIsUnauthorized() {
        assertThatThrownBy(() -> useCase.issue(
                new Principal(userId, deviceId, workspaceId, "req"), null))
                .isInstanceOf(RealtimeTicketInvalidException.class)
                .extracting(ex -> ((RealtimeTicketInvalidException) ex).category())
                .isEqualTo(ErrorCategory.UNAUTHORIZED);
    }

    @Test
    void foreignDeviceIsForbidden() {
        UUID foreignDevice = UUID.randomUUID();
        when(devicePort.isActiveDeviceOfUser(foreignDevice, userId)).thenReturn(false);

        assertThatThrownBy(() -> useCase.issue(
                new Principal(userId, foreignDevice, workspaceId, "req"),
                foreignDevice.toString()))
                .isInstanceOf(RealtimeForbiddenException.class)
                .extracting(ex -> ((RealtimeForbiddenException) ex).category())
                .isEqualTo(ErrorCategory.FORBIDDEN);
        verify(ticketRepository, org.mockito.Mockito.never()).save(any());
    }
}
