package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.usecase.SessionTimeoutGuard;
import ru.krug.backend.auth.domain.repository.SessionActivityRepository;
import ru.krug.backend.auth.domain.repository.SessionTimeoutRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/** #101 idle-timeout decision table for the refresh path. */
class SessionTimeoutGuardTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final String SID = "keycloak-session-1";
    private static final Instant NOW = Instant.parse("2026-11-23T10:00:00Z");

    private final TenantContext tenantContext = mock(TenantContext.class);
    private final SessionActivityRepository activity = mock(SessionActivityRepository.class);
    private final SessionTimeoutRepository timeouts = mock(SessionTimeoutRepository.class);
    private final ClockPort clock = mock(ClockPort.class);
    private final SessionTimeoutGuard guard =
            new SessionTimeoutGuard(tenantContext, activity, timeouts, clock);

    @BeforeEach
    void setUp() {
        when(clock.now()).thenReturn(NOW);
    }

    @Test
    void devSessionWithoutSidIsNotEnforced() {
        assertThat(guard.isExpired(USER_ID, null)).isFalse();
        verifyNoInteractions(tenantContext, activity, timeouts);
    }

    @Test
    void noWorkspacePolicySkipsEnforcement() {
        when(timeouts.effectiveTimeoutMinutes(USER_ID)).thenReturn(0);

        assertThat(guard.isExpired(USER_ID, SID)).isFalse();

        verify(tenantContext).activate(any(Principal.class));
        verify(activity, never()).lastActivity(any(), anyString());
    }

    @Test
    void missingMarkerBootstrapsTheSessionAndAllowsTheRefresh() {
        when(timeouts.effectiveTimeoutMinutes(USER_ID)).thenReturn(60);
        when(activity.lastActivity(USER_ID, SID)).thenReturn(Optional.empty());

        assertThat(guard.isExpired(USER_ID, SID)).isFalse();

        verify(activity).touch(USER_ID, SID, NOW);
    }

    @Test
    void recentActivityAllowsTheRefreshWithoutResettingTheIdleClock() {
        when(timeouts.effectiveTimeoutMinutes(USER_ID)).thenReturn(30);
        when(activity.lastActivity(USER_ID, SID))
                .thenReturn(Optional.of(NOW.minusSeconds(29 * 60)));

        assertThat(guard.isExpired(USER_ID, SID)).isFalse();
        // Refresh must not count as activity, otherwise an abandoned auto-refreshing tab
        // would never expire.
        verify(activity, never()).touch(any(), anyString(), any());
    }

    @Test
    void activityOlderThanTheWorkspaceTimeoutExpiresTheSession() {
        when(timeouts.effectiveTimeoutMinutes(USER_ID)).thenReturn(15);
        when(activity.lastActivity(USER_ID, SID))
                .thenReturn(Optional.of(NOW.minusSeconds(15 * 60 + 1)));

        assertThat(guard.isExpired(USER_ID, SID)).isTrue();
        verify(activity, never()).touch(any(), anyString(), any());
    }

    @Test
    void exactlyAtTheTimeoutBoundaryIsStillAllowed() {
        when(timeouts.effectiveTimeoutMinutes(USER_ID)).thenReturn(15);
        when(activity.lastActivity(USER_ID, SID))
                .thenReturn(Optional.of(NOW.minusSeconds(15 * 60)));

        assertThat(guard.isExpired(USER_ID, SID)).isFalse();
    }
}
