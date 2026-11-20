package ru.krug.backend.plugin.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.plugin.application.model.PluginArchive;
import ru.krug.backend.plugin.application.model.PluginPackageView;
import ru.krug.backend.plugin.application.port.PluginAssetStoragePort;
import ru.krug.backend.plugin.application.port.PluginPackageArchivePort;
import ru.krug.backend.plugin.application.port.PluginPackageInvalidException;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginAsset;
import ru.krug.backend.plugin.domain.model.PluginKind;
import ru.krug.backend.plugin.domain.model.PluginManifest;
import ru.krug.backend.plugin.domain.model.PluginPackage;
import ru.krug.backend.plugin.domain.model.PluginPackageObject;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /admin/plugins}: admin-only install of a static plugin ZIP.
 *
 * <p>The archive is validated and bounded before anything is persisted. Assets are then
 * written to object storage, and only afterwards the catalog/package rows are committed.
 * If the transaction fails, stored objects are deleted best-effort. No plugin code is
 * executed and no network call is made.</p>
 */
@Service
public class InstallPluginPackageService {

    private static final Logger log =
            LoggerFactory.getLogger(InstallPluginPackageService.class);

    static final long MAX_ARCHIVE_BYTES = 5L * 1024 * 1024;

    private final PlatformAdminGuard adminGuard;
    private final PluginPackageArchivePort archiveReader;
    private final PluginAssetStoragePort storage;
    private final PluginCatalogRepository catalog;
    private final PluginPackageRepository packages;
    private final PluginPackageWriter writer;
    private final ClockPort clock;

    public InstallPluginPackageService(PlatformAdminGuard adminGuard,
                                       PluginPackageArchivePort archiveReader,
                                       PluginAssetStoragePort storage,
                                       PluginCatalogRepository catalog,
                                       PluginPackageRepository packages,
                                       PluginPackageWriter writer,
                                       ClockPort clock) {
        this.adminGuard = adminGuard;
        this.archiveReader = archiveReader;
        this.storage = storage;
        this.catalog = catalog;
        this.packages = packages;
        this.writer = writer;
        this.clock = clock;
    }

    public PluginPackageView install(Principal principal, byte[] archiveBytes) {
        adminGuard.require(principal);
        if (archiveBytes == null || archiveBytes.length == 0) {
            throw invalid("archive is empty");
        }
        if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
            throw tooLarge();
        }

        PluginArchive archive = read(archiveBytes);
        PluginManifest manifest = archive.manifest();
        checkAvailability(manifest.id());

        java.time.Instant installedAt = clock.now();
        List<PluginPackageObject> objects = storeAssets(manifest, archive.assets());
        try {
            writer.write(principal, manifest, archive, objects, installedAt);
        } catch (DataIntegrityViolationException ex) {
            log.warn("plugin.package.install_conflict type={}", ex.getClass().getSimpleName());
            deleteQuietly(objects);
            throw conflict(ErrorCode.PLUGIN_ALREADY_INSTALLED,
                    "Plugin package is already installed", manifest.id());
        } catch (RuntimeException ex) {
            deleteQuietly(objects);
            throw ex;
        }
        return new PluginPackageView(
                manifest.id(),
                manifest.name(),
                manifest.version(),
                manifest.description(),
                manifest.author(),
                manifest.entry(),
                manifest.permissions(),
                manifest.modes().stream().map(Enum::name).toList(),
                archive.archiveSizeBytes(),
                archive.fileCount(),
                archive.archiveSha256(),
                installedAt);
    }

    private PluginArchive read(byte[] archiveBytes) {
        try {
            return archiveReader.read(archiveBytes);
        } catch (PluginPackageInvalidException ex) {
            throw invalid(ex.getMessage());
        } catch (IllegalArgumentException ex) {
            throw invalid("archive contains an invalid path or manifest value");
        }
    }

    private void checkAvailability(String pluginId) {
        Plugin existing = catalog.findAnyById(pluginId).orElse(null);
        if (existing == null) {
            return;
        }
        if (existing.kind() == PluginKind.BUILTIN) {
            throw conflict(ErrorCode.PLUGIN_ID_RESERVED,
                    "Plugin id belongs to a built-in plugin", pluginId);
        }
        if (packages.findByPluginId(pluginId).isPresent()) {
            throw conflict(ErrorCode.PLUGIN_ALREADY_INSTALLED,
                    "Plugin package is already installed", pluginId);
        }
    }

    private List<PluginPackageObject> storeAssets(PluginManifest manifest,
                                                  List<PluginAsset> assets) {
        String installId = UUID.randomUUID().toString().replace("-", "");
        String prefix = "plugin-packages/" + manifest.id() + "/" + manifest.version()
                + "/" + installId + "/";
        List<PluginPackageObject> objects = new ArrayList<>(assets.size());
        try {
            for (PluginAsset asset : assets) {
                String objectKey = prefix + asset.path();
                storage.put(objectKey, asset.content(), asset.contentType());
                objects.add(new PluginPackageObject(manifest.id(), asset.path(), objectKey,
                        asset.contentType(), asset.size(), asset.sha256()));
            }
            return objects;
        } catch (RuntimeException ex) {
            deleteQuietly(objects);
            throw ex;
        }
    }

    private void deleteQuietly(List<PluginPackageObject> objects) {
        for (PluginPackageObject object : objects) {
            try {
                storage.delete(object.objectKey());
            } catch (RuntimeException ex) {
                log.warn("plugin.package.cleanup_failed plugin_id={} reason={}",
                        object.pluginId(), ex.getClass().getSimpleName());
            }
        }
    }

    private static DomainException invalid(String message) {
        return new DomainException(ErrorCategory.BAD_REQUEST, ErrorCode.PLUGIN_PACKAGE_INVALID,
                message, Map.of(), null);
    }

    private static DomainException tooLarge() {
        return DomainException.payloadTooLarge(ErrorCode.PLUGIN_PACKAGE_TOO_LARGE,
                "Plugin package exceeds the 5 MiB limit",
                Map.of("max_bytes", MAX_ARCHIVE_BYTES));
    }

    private static DomainException conflict(String code, String message, String pluginId) {
        return DomainException.conflict(code, message, Map.of("plugin_id", pluginId));
    }
}
