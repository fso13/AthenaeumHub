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
import ru.krug.backend.workspace.domain.model.DlpScope;
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

    @Test
    void attachmentFilenameRuleBlocksWithAttachmentSurfaceAndNoFileName() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                attachmentPolicy("Block executables", DlpAction.BLOCK, DlpPatternType.PATTERN,
                        "*.exe", null)));

        assertThatThrownBy(() -> service.enforceAttachment(principal, CHAT_ID,
                "Quarterly Report.EXE", "application/octet-stream", 10L))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("DLP_BLOCKED");
                    assertThat(ex.details()).containsEntry("surface", "ATTACHMENT");
                });

        ArgumentCaptor<DlpEvent> event = ArgumentCaptor.forClass(DlpEvent.class);
        verify(events).appendIndependently(any(), event.capture());
        assertThat(event.getValue().chatId()).isEqualTo(CHAT_ID);
        assertThat(event.getValue().toString()).doesNotContain("Quarterly", ".EXE");
    }

    @Test
    void attachmentSizeThresholdBlocksEvenWhenThePatternDoesNotMatch() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                attachmentPolicy("Small files only", DlpAction.BLOCK, DlpPatternType.PATTERN,
                        "*.exe", 1_024L)));

        service.enforceAttachment(principal, null, "small.pdf", "application/pdf", 1_024L);
        verifyNoInteractions(events);

        assertThatThrownBy(() -> service.enforceAttachment(principal, null, "small.pdf",
                "application/pdf", 1_025L))
                .isInstanceOf(DomainException.class);
        verify(events).appendIndependently(any(), any());
    }

    @Test
    void textScopeRuleDoesNotApplyToAnAttachmentOrPluginPayload() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                policy("Text only", DlpAction.BLOCK, "secret", DlpScope.TEXT)));

        service.enforceAttachment(principal, CHAT_ID, "secret.pdf", "application/pdf", 10L);
        service.enforcePluginPayload(principal, CHAT_ID, List.of("secret question"));
        verifyNoInteractions(events);
    }

    @Test
    void pluginPayloadMatchesEachFieldIndependently() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                policy("Block roadmap", DlpAction.BLOCK, "roadmap", DlpScope.PLUGIN)));

        assertThatThrownBy(() -> service.enforcePluginPayload(principal, CHAT_ID,
                List.of("Release plan", "Q1 roadmap", "")))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("DLP_BLOCKED");
                    assertThat(ex.details()).containsEntry("surface", "PLUGIN");
                });
        verify(events).appendIndependently(any(), any());
        verify(events, never()).append(any());
    }

    @Test
    void pluginWarnDoesNotBlockAndSkipsBlankFields() {
        when(settings.find(WORKSPACE_ID)).thenReturn(Optional.of(security(true)));
        when(policies.findAll(WORKSPACE_ID)).thenReturn(List.of(
                policy("Warn roadmap", DlpAction.WARN, "roadmap", DlpScope.PLUGIN)));

        service.enforcePluginPayload(principal, CHAT_ID, List.of("", "the roadmap"));
        ArgumentCaptor<DlpEvent> event = ArgumentCaptor.forClass(DlpEvent.class);
        verify(events).append(event.capture());
        assertThat(event.getValue().action()).isEqualTo(DlpAction.WARN);
    }

    private static WorkspaceSecuritySettings security(boolean dlpEnabled) {
        return new WorkspaceSecuritySettings(WORKSPACE_ID, false, 60, dlpEnabled, 180, NOW,
                USER_ID);
    }

    private static DlpPolicy policy(String name, DlpAction action, String pattern) {
        return policy(name, action, pattern, DlpScope.ALL);
    }

    private static DlpPolicy policy(String name, DlpAction action, String pattern,
                                    DlpScope scope) {
        return new DlpPolicy(UUID.randomUUID(), WORKSPACE_ID, name, action,
                DlpPatternType.KEYWORD, pattern, scope, null, true, USER_ID, NOW, NOW);
    }

    private static DlpPolicy attachmentPolicy(String name, DlpAction action,
                                              DlpPatternType type, String pattern,
                                              Long maxFileSizeBytes) {
        return new DlpPolicy(UUID.randomUUID(), WORKSPACE_ID, name, action, type, pattern,
                DlpScope.ATTACHMENT, maxFileSizeBytes, true, USER_ID, NOW, NOW);
    }
}
