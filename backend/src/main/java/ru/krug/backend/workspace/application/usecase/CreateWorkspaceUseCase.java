package ru.krug.backend.workspace.application.usecase;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.workspace.application.command.CreateWorkspaceCommand;
import ru.krug.backend.workspace.application.model.CreateWorkspaceResult;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;

/**
 * Idempotency orchestration for {@code POST /workspaces}: reserve, onboard in one
 * transaction, complete; replay is resolved by the workspace id.
 */
@Service
public class CreateWorkspaceUseCase {

    public static final String IDEMPOTENCY_SCOPE = "POST /api/v1/workspaces";
    private static final Logger log = LoggerFactory.getLogger(CreateWorkspaceUseCase.class);

    private final IdempotencyPort idempotency;
    private final WorkspaceOnboardingService onboarding;
    private final WorkspaceQueryService query;
    private final RequestCanonicalizer canonicalizer;

    public CreateWorkspaceUseCase(IdempotencyPort idempotency,
                                  WorkspaceOnboardingService onboarding,
                                  WorkspaceQueryService query,
                                  RequestCanonicalizer canonicalizer) {
        this.idempotency = idempotency;
        this.onboarding = onboarding;
        this.query = query;
        this.canonicalizer = canonicalizer;
    }

    public CreateWorkspaceResult create(Principal principal, UUID key,
                                        CreateWorkspaceCommand command) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("name", command.name());
        canonical.put("security_mode", command.securityMode());
        byte[] hash = canonicalizer.sha256("POST\n/api/v1/workspaces\n"
                + canonicalizer.canonicalize(canonical));

        IdempotencyReservation reservation = idempotency.reserve(principal,
                IDEMPOTENCY_SCOPE, key.toString(), hash);
        if (reservation.replay()) {
            WorkspaceSummaryView replayed = query.findById(principal,
                    reservation.resourceId());
            return new CreateWorkspaceResult(201, replayed, true);
        }

        try {
            WorkspaceSummaryView created = onboarding.create(principal, command);
            idempotency.complete(principal, IDEMPOTENCY_SCOPE, key.toString(), hash, 201,
                    created.id());
            return new CreateWorkspaceResult(201, created, false);
        } catch (RuntimeException ex) {
            abandonQuietly(principal, key);
            throw ex;
        }
    }

    private void abandonQuietly(Principal principal, UUID key) {
        try {
            idempotency.abandon(principal, IDEMPOTENCY_SCOPE, key.toString());
        } catch (RuntimeException ex) {
            log.warn("Could not release workspace idempotency reservation request_id={}",
                    principal.requestId());
        }
    }
}
