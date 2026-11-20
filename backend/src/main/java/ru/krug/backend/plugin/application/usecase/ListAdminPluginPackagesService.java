package ru.krug.backend.plugin.application.usecase;

import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.plugin.application.model.PluginPackageView;
import ru.krug.backend.plugin.domain.model.PluginPackage;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;
import ru.krug.backend.shared.application.model.Principal;

/** {@code GET /admin/plugins}: admin-only list of installed external packages. */
@Service
public class ListAdminPluginPackagesService {

    private final PlatformAdminGuard adminGuard;
    private final PluginPackageRepository packages;

    public ListAdminPluginPackagesService(PlatformAdminGuard adminGuard,
                                          PluginPackageRepository packages) {
        this.adminGuard = adminGuard;
        this.packages = packages;
    }

    @Transactional(readOnly = true)
    public List<PluginPackageView> list(Principal principal) {
        adminGuard.require(principal);
        return packages.findAll().stream()
                .map(ListAdminPluginPackagesService::toView)
                .toList();
    }

    static PluginPackageView toView(PluginPackage pluginPackage) {
        return new PluginPackageView(
                pluginPackage.pluginId(),
                pluginPackage.name(),
                pluginPackage.version(),
                pluginPackage.description(),
                pluginPackage.author(),
                pluginPackage.entry(),
                pluginPackage.permissions(),
                pluginPackage.modes().stream().map(Enum::name).toList(),
                pluginPackage.archiveSizeBytes(),
                pluginPackage.fileCount(),
                pluginPackage.archiveSha256(),
                pluginPackage.installedAt());
    }
}
