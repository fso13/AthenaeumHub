package ru.krug.backend.ops.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.SystemSettingsView;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.shared.application.model.Principal;

/** {@code GET /admin/settings}: platform admin only, password never returned. */
@Service
public class GetAdminSettingsService {

    private final PlatformAdminGuard adminGuard;
    private final SystemSettingsPort settings;

    public GetAdminSettingsService(PlatformAdminGuard adminGuard, SystemSettingsPort settings) {
        this.adminGuard = adminGuard;
        this.settings = settings;
    }

    @Transactional(readOnly = true)
    public SystemSettingsView get(Principal principal) {
        adminGuard.require(principal);
        return settings.current();
    }
}
