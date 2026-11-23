package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.auth.application.usecase.SessionActivityService;
import ru.krug.backend.auth.application.usecase.SessionTimeoutGuard;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * #101 server-side session idle tracking and timeout enforcement at refresh. The activity
 * table is self-scoped, content-free and never touched by a manual refresh.
 */
@ActiveProfiles("test")
class SessionActivityIT extends IntegrationTestBase {

    @Autowired
    private SessionActivityService activityService;

    @Autowired
    private SessionTimeoutGuard timeoutGuard;

    @Test
    void activityRowsAreSelfScopedAndContainNoSecrets() throws Exception {
        SessionResponse first = devSession(uniqueDisplayName("session-a"));
        SessionResponse second = devSession(uniqueDisplayName("session-b"));
        String sid = "keycloak-session-" + UUID.randomUUID();

        activityService.touch(first.user().id(), sid);

        assertThat(activityCount(first.user().id(), sid)).isEqualTo(1);
        // The second user cannot read or overwrite the first user's marker, even when it
        // presents the same sid; a distinct sid gets its own row.
        assertThat(timeoutGuard.isExpired(second.user().id(), sid)).isFalse();
        assertThat(activityCount(second.user().id(), sid)).isZero();
        assertThat(activityCount(first.user().id(), sid)).isEqualTo(1);
        String secondSid = "keycloak-session-" + UUID.randomUUID();
        assertThat(timeoutGuard.isExpired(second.user().id(), secondSid)).isFalse();
        assertThat(activityCount(second.user().id(), secondSid)).isEqualTo(1);
        List<String> columns = migrator().queryForList("""
                SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'auth' AND table_name = 'session_activity'
                 ORDER BY ordinal_position
                """, String.class);
        assertThat(columns).containsExactly("session_id", "user_id", "first_seen_at",
                "last_activity_at");
    }

    @Test
    void idleSessionExpiresAgainstTheWorkspacePolicyAtRefresh() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("session-timeout"));
        UUID userId = session.user().id();
        UUID workspaceId = session.workspace().id();
        String sid = "keycloak-session-" + UUID.randomUUID();
        activityService.touch(userId, sid);

        // Default workspace policy (60 minutes): 16 minutes idle is still allowed.
        migrator().update("""
                UPDATE auth.session_activity SET last_activity_at = ?
                 WHERE session_id = ? AND user_id = ?
                """, Timestamp.from(Instant.now().minus(16, ChronoUnit.MINUTES)), sid, userId);
        assertThat(timeoutGuard.isExpired(userId, sid)).isFalse();

        // The OWNER narrows the window to 15 minutes: the same marker is now expired.
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId),
                        session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "session_timeout_minutes", 15))))
                .andExpect(status().isOk());

        assertThat(timeoutGuard.isExpired(userId, sid)).isTrue();
        // The expired session has no side effect on the marker; a fresh login creates a
        // new sid and therefore starts from a clean state.
        assertThat(activityCount(userId, sid)).isEqualTo(1);

        String otherSid = "keycloak-session-" + UUID.randomUUID();
        assertThat(timeoutGuard.isExpired(userId, otherSid)).isFalse();
        assertThat(activityCount(userId, otherSid)).isEqualTo(1);
    }

    private long activityCount(UUID userId, String sessionId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM auth.session_activity
                 WHERE user_id = ? AND session_id = ?
                """, Long.class, userId, sessionId);
        return count == null ? 0 : count;
    }

    @Test
    void devSessionsWithoutSidAreNotTrackedOrRejected() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("session-dev"));
        assertThat(timeoutGuard.isExpired(session.user().id(), null)).isFalse();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.session_activity WHERE user_id = ?
                """, Long.class, session.user().id())).isZero();
    }
}
