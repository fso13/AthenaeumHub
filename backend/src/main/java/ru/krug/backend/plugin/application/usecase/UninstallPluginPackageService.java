package ru.krug.backend.plugin.application.usecase;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.plugin.application.port.PluginAssetStoragePort;
import ru.krug.backend.plugin.domain.model.PluginPackage;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code DELETE /admin/plugins/{pluginId}}: admin-only uninstall. The database change is
 * transactional; object deletion is best-effort after the commit so a storage outage can
 * never leave a half-uninstalled catalog row.
 */
@Service
public class UninstallPluginPackageService {

    private static final Logger log =
            LoggerFactory.getLogger(UninstallPluginPackageService.class);

    private final PlatformAdminGuard adminGuard;
    private final PluginPackageRepository packages;
    private final PluginPackageUninstallWriter writer;
    private final PluginAssetStoragePort storage;

    public UninstallPluginPackageService(PlatformAdminGuard adminGuard,
                                         PluginPackageRepository packages,
                                         PluginPackageUninstallWriter writer,
                                         PluginAssetStoragePort storage) {
        this.adminGuard = adminGuard;
        this.packages = packages;
        this.writer = writer;
        this.storage = storage;
    }

    public void uninstall(Principal principal, String pluginId) {
        adminGuard.require(principal);
        PluginPackage pluginPackage = packages.findByPluginId(pluginId)
                .orElseThrow(() -> DomainException.notFound(ErrorCode.PLUGIN_NOT_FOUND,
                        "Plugin package not found", Map.of("plugin_id", pluginId)));
        List<String> objectKeys = writer.uninstall(principal, pluginPackage);
        for (String objectKey : objectKeys) {
            try {
                storage.delete(objectKey);
            } catch (RuntimeException ex) {
                log.warn("plugin.package.uninstall_cleanup_failed plugin_id={} reason={}",
                        pluginId, ex.getClass().getSimpleName());
            }
        }
    }
}
