package ru.krug.backend.notification.application.usecase;

import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.notification.application.model.NotificationPreferenceView;
import ru.krug.backend.notification.domain.repository.NotificationPreferenceRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/** GET /notification-preferences: all stored rows for the caller. */
@Service
public class GetPreferencesUseCase {

    private final TenantContext tenantContext;
    private final NotificationPreferenceRepository preferences;

    public GetPreferencesUseCase(TenantContext tenantContext,
                                 NotificationPreferenceRepository preferences) {
        this.tenantContext = tenantContext;
        this.preferences = preferences;
    }

    @Transactional(readOnly = true)
    public List<NotificationPreferenceView> get(Principal principal) {
        tenantContext.activate(principal);
        // The contract's preference DTO has no workspace_id and the caller may hold
        // per-chat rows for workspaces other than the token's default workspace, so all
        // of the caller's rows are returned.
        return NotificationPreferenceView.from(preferences.findByUser(principal.userId()));
    }
}
