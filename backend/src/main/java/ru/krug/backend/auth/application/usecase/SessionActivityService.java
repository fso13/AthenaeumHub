package ru.krug.backend.auth.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.domain.repository.SessionActivityRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Records server-side session activity (#101) for an authenticated API request.
 *
 * <p>The Keycloak access token carries a {@code sid} claim; the caller's local user id is
 * resolved by the device-binding filter. The marker is written under the self-scoped RLS
 * policy (the transaction GUCs are set here). It is deliberately not written for
 * {@code /auth/refresh}: a client that silently refreshes an abandoned tab must still hit
 * the idle timeout. The record is content-free.</p>
 */
@Service
public class SessionActivityService {

    private static final String REQUEST_ID = "session-activity";

    private final TenantContext tenantContext;
    private final SessionActivityRepository repository;
    private final ClockPort clock;

    public SessionActivityService(TenantContext tenantContext,
                                  SessionActivityRepository repository, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.repository = repository;
        this.clock = clock;
    }

    @Transactional
    public void touch(UUID userId, String sessionId) {
        if (userId == null || sessionId == null || sessionId.isBlank()) {
            return;
        }
        tenantContext.activate(new Principal(userId, null, null, REQUEST_ID));
        repository.touch(userId, sessionId, clock.now());
    }
}
