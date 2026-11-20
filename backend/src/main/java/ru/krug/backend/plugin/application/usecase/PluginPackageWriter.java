package ru.krug.backend.plugin.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.plugin.application.model.PluginArchive;
import ru.krug.backend.plugin.domain.model.PluginManifest;
import ru.krug.backend.plugin.domain.model.PluginPackage;
import ru.krug.backend.plugin.domain.model.PluginPackageObject;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.plugin.domain.repository.PluginPackageObjectRepository;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Transactional half of the install flow: catalog row, package metadata and object-key
 * rows commit together with the install audit event. Asset bytes were already written to
 * object storage by the caller; a failed transaction triggers best-effort cleanup there.
 */
@Service
public class PluginPackageWriter {

    static final String ACTION = "admin.plugin.installed";

    private final PluginCatalogRepository catalog;
    private final PluginPackageRepository packages;
    private final PluginPackageObjectRepository objects;
    private final AuditPort audit;
    private final ClockPort clock;
    private final TenantContext tenantContext;

    public PluginPackageWriter(PluginCatalogRepository catalog,
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

    @Transactional
    public void write(Principal principal, PluginManifest manifest, PluginArchive archive,
                      List<PluginPackageObject> packageObjects, Instant installedAt) {
        tenantContext.activate(principal);
        catalog.installExternal(manifest);
        packages.save(new PluginPackage(
                manifest.id(),
                manifest.name(),
                manifest.version(),
                manifest.description(),
                manifest.author(),
                manifest.entry(),
                manifest.permissions(),
                manifest.modes(),
                archive.archiveSha256(),
                archive.archiveSizeBytes(),
                archive.unpackedSizeBytes(),
                archive.fileCount(),
                principal.userId(),
                installedAt));
        objects.saveAll(packageObjects);
        audit.append(new AuditRecord(null, principal.userId(), ACTION, "plugin", null,
                principal.requestId(),
                Map.of("plugin_id", manifest.id(),
                        "version", manifest.version(),
                        "file_count", archive.fileCount(),
                        "archive_size_bytes", archive.archiveSizeBytes(),
                        "unpacked_size_bytes", archive.unpackedSizeBytes()),
                installedAt));
    }
}
