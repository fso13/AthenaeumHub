package ru.krug.backend.auth.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.UserProfileView;
import ru.krug.backend.auth.application.port.UserProfilePort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * Server-side platform-admin gate for every administrative operation (FR-ADM-8). The flag
 * is loaded from {@code auth.users} after the tenant context is activated; a client claim
 * or {@code GET /me} response is never trusted.
 */
@Service
public class PlatformAdminGuard {

    private final TenantContext tenantContext;
    private final UserProfilePort userProfile;

    public PlatformAdminGuard(TenantContext tenantContext, UserProfilePort userProfile) {
        this.tenantContext = tenantContext;
        this.userProfile = userProfile;
    }

    @Transactional(readOnly = true)
    public UserProfileView require(Principal principal) {
        tenantContext.activate(principal);
        UserProfileView profile = userProfile.requireProfile(principal.userId());
        if (!profile.platformAdmin()) {
            throw DomainException.forbidden("Platform administrator role is required");
        }
        return profile;
    }
}
