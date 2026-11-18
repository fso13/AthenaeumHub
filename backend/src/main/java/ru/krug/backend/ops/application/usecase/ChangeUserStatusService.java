package ru.krug.backend.ops.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.domain.model.AdminUserDetailRow;
import ru.krug.backend.ops.domain.model.AdminUserStatusChange;
import ru.krug.backend.ops.domain.repository.AdminActionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /admin/users/{userId}/suspend|activate} (FR-ADM-15).
 *
 * <p>Order of operations: platform-admin guard -> self/last-admin/state validation ->
 * local status (one atomic SECURITY DEFINER call) -> Keycloak disable/enable + session
 * logout -> audit. The Keycloak call runs inside the transaction on purpose: a provider
 * failure rolls the local status back, so the API never claims a suspension that the IdP
 * did not apply. A successful IdP call with a later rollback is fail-safe: a locally
 * SUSPENDED user is still rejected by JIT provisioning and login.</p>
 *
 * <p>Audit metadata carries the previous/new status only — never the email or display
 * name. The event is appended in the admin's own hash-chain scope (workspace_id = null),
 * because this is an installation-level action, not tenant data.</p>
 */
@Service
public class ChangeUserStatusService {

    static final String ACTION_SUSPENDED = "admin.user.suspended";
    static final String ACTION_ACTIVATED = "admin.user.activated";
    static final String STATUS_ACTIVE = "ACTIVE";
    static final String STATUS_SUSPENDED = "SUSPENDED";

    private final PlatformAdminGuard adminGuard;
    private final AdminActionRepository actions;
    private final KeycloakAdminPort keycloak;
    private final AuditPort audit;
    private final DeviceKeyEvents events;
    private final ClockPort clock;

    public ChangeUserStatusService(PlatformAdminGuard adminGuard,
                                   AdminActionRepository actions,
                                   KeycloakAdminPort keycloak,
                                   AuditPort audit,
                                   DeviceKeyEvents events,
                                   ClockPort clock) {
        this.adminGuard = adminGuard;
        this.actions = actions;
        this.keycloak = keycloak;
        this.audit = audit;
        this.events = events;
        this.clock = clock;
    }

    @Transactional
    public void suspend(Principal principal, UUID userId) {
        apply(principal, userId, STATUS_SUSPENDED);
    }

    @Transactional
    public void activate(Principal principal, UUID userId) {
        apply(principal, userId, STATUS_ACTIVE);
    }

    private void apply(Principal principal, UUID userId, String status) {
        adminGuard.require(principal);
        boolean suspend = STATUS_SUSPENDED.equals(status);
        if (suspend && principal.userId().equals(userId)) {
            throw DomainException.conflict(ErrorCode.SELF_ACTION_FORBIDDEN,
                    "An administrator cannot suspend their own account",
                    Map.of("field", "user_id"));
        }
        AdminUserDetailRow target = actions.findUser(userId)
                .orElseThrow(() -> DomainException.notFound("User not found"));
        if (target.status().equals(status)) {
            throw stateConflict(suspend);
        }

        AdminUserStatusChange change = actions.setUserStatus(userId, status);
        switch (change.outcome()) {
            case NOT_FOUND -> throw DomainException.notFound("User not found");
            case ALREADY -> throw stateConflict(suspend);
            case LAST_ADMIN -> throw DomainException.conflict(ErrorCode.LAST_PLATFORM_ADMIN,
                    "The last platform administrator cannot be suspended",
                    Map.of("field", "user_id"));
            case OK -> {
                // Continue: local state is changed inside this transaction.
            }
        }

        applyIdentityProviderChange(target, suspend);

        audit.append(new AuditRecord(null, principal.userId(),
                suspend ? ACTION_SUSPENDED : ACTION_ACTIVATED, "user", userId,
                principal.requestId(),
                Map.of("previous_status", target.status(), "status", status), clock.now()));

        if (suspend) {
            // Delivered after commit; closes every live WS session of the suspended user.
            events.userSessionsRevoked(userId, "USER_SUSPENDED");
        }
    }

    /**
     * Keycloak is the source of truth for credentials. A missing keycloak account (for
     * example a local dev/test user) is a no-op; an unreachable IdP is a 503 and rolls the
     * transaction back.
     */
    private void applyIdentityProviderChange(AdminUserDetailRow target, boolean suspend) {
        if (target.email() == null || target.email().isBlank()) {
            return;
        }
        try {
            keycloak.findByEmail(target.email()).ifPresent(user -> {
                keycloak.setEnabled(user.id(), !suspend);
                if (suspend) {
                    keycloak.logoutAllSessions(user.id());
                }
            });
        } catch (ProviderUnavailableException ex) {
            throw DomainException.serviceUnavailable(ErrorCode.AUTH_UNAVAILABLE,
                    "Identity provider is unavailable", Map.of("reason", "keycloak_unavailable"),
                    5L);
        }
    }

    private static DomainException stateConflict(boolean suspend) {
        return suspend
                ? DomainException.conflict(ErrorCode.USER_ALREADY_SUSPENDED,
                        "User is already suspended", Map.of("field", "status"))
                : DomainException.conflict(ErrorCode.USER_ALREADY_ACTIVE,
                        "User is already active", Map.of("field", "status"));
    }
}
