package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.DlpEventAppender;
import ru.krug.backend.workspace.application.usecase.WorkspaceDlpEnforcementService;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpEvent;
import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;
import ru.krug.backend.workspace.domain.repository.DlpPolicyRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceSecuritySettingsRepository;

/** DLP send-gate decision table: disabled, WARN and BLOCK. */
class WorkspaceDlpEnforcementServiceTest {

    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID CHAT_ID = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-20T10:00:00Z");

    private final WorkspaceSecuritySettingsRepository settings =
            mock(WorkspaceSecuritySettingsRepository.class);
    private final DlpPolicyRepository policies = mock(DlpPolicyRepository.class);
    private final DlpEventAppender events = mock(DlpEventAppender.class);
    private final ClockPort clock = mock(ClockPort.class);

    private WorkspaceDlpEnforcementService service;
    private Principal principal;

    @BeforeEach
    void setUp() {
        service = new WorkspaceDlpEnforcementService(settings, policies, events, clock);
        principal = new Principal(USER_ID, UUID.randomUUID(), WORKSPACE_ID, "req-dlp");
        when(clock.now()).thenReturn(NOW);
    }

    @Test
    void disabledWorkspaceDoesNoPolicyReadOrEventWrite() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(false)));

        service.enforce(principal, CHAT_ID, "top-secret");

        verifyNoInteractions(policies, events);
    }

    @Test
    void missingSettingsRowFailsOpenWithoutPolicies() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.empty());

        service.enforce(principal, CHAT_ID, "top-secret");

        verifyNoInteractions(policies, events);
    }

    @Test
    void warnRecordsOneContentFreeEventAndAllowsTheMessage() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                policy("Warn card", DlpAction.WARN, "card-number"),
                policy("Block secret", DlpAction.BLOCK, "top-secret")));

        service.enforce(principal, CHAT_ID, "my card-number is here");

        ArgumentCaptor<DlpEvent> event = ArgumentCaptor.forClass(DlpEvent.class);
        verify(events).append(event.capture());
        verify(events, never()).appendIndependently(any(), any());
        assertThat(event.getValue().action()).isEqualTo(DlpAction.WARN);
        assertThat(event.getValue().ruleName()).isEqualTo("Warn card");
        assertThat(event.getValue().workspaceId()).isEqualTo(WORKSPACE_ID);
        assertThat(event.getValue().actorId()).isEqualTo(USER_ID);
        assertThat(event.getValue().chatId()).isEqualTo(CHAT_ID);
    }

    @Test
    void blockWritesIndependentlyThenThrows() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                policy("Block secret", DlpAction.BLOCK, "top-secret")));

        assertThatThrownBy(() -> service.enforce(principal, CHAT_ID,
                "here is a top-secret value"))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("DLP_BLOCKED");
                    assertThat(ex.details()).containsEntry("action", "BLOCK");
                });

        ArgumentCaptor<DlpEvent> event = ArgumentCaptor.forClass(DlpEvent.class);
        verify(events).appendIndependently(any(), event.capture());
        verify(events, never()).append(any());
        assertThat(event.getValue().action()).isEqualTo(DlpAction.BLOCK);
        assertThat(event.getValue().ruleName()).isEqualTo("Block secret");
    }

    private static WorkspaceSecuritySettings security(boolean dlpEnabled) {
        return new WorkspaceSecuritySettings(WORKSPACE_ID, false, 60, dlpEnabled, 180, NOW,
                USER_ID);
    }

    private static DlpPolicy policy(String name, DlpAction action, String pattern) {
        return new DlpPolicy(UUID.randomUUID(), WORKSPACE_ID, name, action,
                DlpPatternType.KEYWORD, pattern, true, USER_ID, NOW, NOW);
    }
}
