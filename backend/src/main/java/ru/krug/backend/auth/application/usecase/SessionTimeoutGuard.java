package ru.krug.backend.auth.application.usecase;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.domain.repository.SessionActivityRepository;
import ru.krug.backend.auth.domain.repository.SessionTimeoutRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Enforces {@code session_timeout_minutes} on token refresh (#101).
 *
 * <p>The BFF is stateless: Keycloak access tokens are short-lived and a browser cannot
 * extend a session except through {@code POST /auth/refresh}. Every authenticated API call
 * records activity in {@code auth.session_activity}; a refresh that arrives after more
 * than the workspace's idle window is rejected with {@code 401 AUTH_SESSION_EXPIRED} and
 * the freshly minted refresh token is revoked. This is real enforcement, not a stored
 * preference: a leaked refresh token cannot outlive the workspace idle policy.</p>
 *
 * <p>Rules:
 * <ul>
 *   <li>no {@code sid} (dev tokens) or no workspace policy → not enforced;</li>
 *   <li>a session without a marker (first refresh after login) is allowed and the marker is
 *       bootstrapped — login itself is not an API activity event;</li>
 *   <li>a manual refresh does not reset the idle clock; only a real API request does;</li>
 *   <li>the strictest workspace timeout wins for a user in several workspaces.</li>
 * </ul>
 * Access tokens that were already issued remain valid only until their normal short TTL;
 * their TTL is the IdP setting and is always shorter than the minimum (15 minute) workspace
 * timeout, so an idle session cannot reach a protected endpoint with an unexpired token
 * after the policy window.</p>
 */
@Service
public class SessionTimeoutGuard {

    private static final String REQUEST_ID = "session-timeout";

    private final TenantContext tenantContext;
    private final SessionActivityRepository activity;
    private final SessionTimeoutRepository timeouts;
    private final ClockPort clock;

    public SessionTimeoutGuard(TenantContext tenantContext, SessionActivityRepository activity,
                               SessionTimeoutRepository timeouts, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.activity = activity;
        this.timeouts = timeouts;
        this.clock = clock;
    }

    @Transactional
    public boolean isExpired(UUID userId, String sessionId) {
        if (userId == null || sessionId == null || sessionId.isBlank()) {
            return false;
        }
        tenantContext.activate(new Principal(userId, null, null, REQUEST_ID));
        int timeoutMinutes = timeouts.effectiveTimeoutMinutes(userId);
        if (timeoutMinutes <= 0) {
            // The user has no active workspace policy; there is nothing to enforce.
            return false;
        }
        Instant now = clock.now();
        Instant lastActivity = activity.lastActivity(userId, sessionId).orElse(null);
        if (lastActivity == null) {
            activity.touch(userId, sessionId, now);
            return false;
        }
        return lastActivity.plus(Duration.ofMinutes(timeoutMinutes)).isBefore(now);
    }
}
