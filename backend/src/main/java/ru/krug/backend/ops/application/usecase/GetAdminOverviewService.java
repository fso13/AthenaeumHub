package ru.krug.backend.ops.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminOverviewView;
import ru.krug.backend.ops.domain.model.PlatformOverview;
import ru.krug.backend.ops.domain.repository.PlatformOverviewRepository;
import ru.krug.backend.shared.application.model.Principal;

/** {@code GET /admin/overview}: aggregate counts only, no tenant/E2EE content. */
@Service
public class GetAdminOverviewService {

    private final PlatformAdminGuard adminGuard;
    private final PlatformOverviewRepository overviewRepository;

    public GetAdminOverviewService(PlatformAdminGuard adminGuard,
                                   PlatformOverviewRepository overviewRepository) {
        this.adminGuard = adminGuard;
        this.overviewRepository = overviewRepository;
    }

    @Transactional(readOnly = true)
    public AdminOverviewView overview(Principal principal) {
        adminGuard.require(principal);
        PlatformOverview overview = overviewRepository.overview();
        return new AdminOverviewView(overview.users(), overview.workspaces(), overview.chats());
    }
}
