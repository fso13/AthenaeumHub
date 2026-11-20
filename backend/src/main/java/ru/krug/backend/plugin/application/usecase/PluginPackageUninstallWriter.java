package ru.krug.backend.plugin.application.usecase;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.plugin.domain.model.PluginPackage;
import ru.krug.backend.plugin.domain.model.PluginPackageObject;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.plugin.domain.repository.PluginPackageObjectRepository;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Transactional half of uninstall: hides the external catalog row, deletes package/blob
 * metadata and appends the audit event. The catalog row is kept (disabled) so
 * {@code chat.chat_plugins} rows that reference the plugin id remain valid.
 */
@Service
public class PluginPackageUninstallWriter {

    static final String ACTION = "admin.plugin.uninstalled";

    private final PluginCatalogRepository catalog;
    private final PluginPackageRepository packages;
    private final PluginPackageObjectRepository objects;
    private final AuditPort audit;
    private final ClockPort clock;
    private final TenantContext tenantContext;

    public PluginPackageUninstallWriter(PluginCatalogRepository catalog,
                                        PluginPackageRepository packages,
                                        PluginPackageObjectRepository objects,
                                        AuditPort audit,
                                        ClockPort clock,
                                        TenantContext tenantContext) {
        this.catalog = catalog;
        this.packages = packages;
        this.objects = objects;
        this.audit = audit;
        this.clock = clock;
        this.tenantContext = tenantContext;
    }

    /** Returns the object keys the caller should delete best-effort after commit. */
    @Transactional
    public List<String> uninstall(Principal principal, PluginPackage pluginPackage) {
        tenantContext.activate(principal);
        List<PluginPackageObject> stored = objects.findByPluginId(pluginPackage.pluginId());
        catalog.markUninstalled(pluginPackage.pluginId());
        packages.delete(pluginPackage.pluginId());
        audit.append(new AuditRecord(null, principal.userId(), ACTION, "plugin", null,
                principal.requestId(),
                Map.of("plugin_id", pluginPackage.pluginId(),
                        "version", pluginPackage.version(),
                        "file_count", pluginPackage.fileCount()),
                clock.now()));
        return stored.stream().map(PluginPackageObject::objectKey).toList();
    }
}
