package ru.krug.backend.plugin.application.usecase;

import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.plugin.application.model.PluginAssetView;
import ru.krug.backend.plugin.application.port.PluginAssetStoragePort;
import ru.krug.backend.plugin.domain.model.PluginAsset;
import ru.krug.backend.plugin.domain.model.PluginPackageObject;
import ru.krug.backend.plugin.domain.model.PluginPaths;
import ru.krug.backend.plugin.domain.repository.PluginPackageObjectRepository;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code GET /plugins/{pluginId}/assets/{*path}}: serves one static package asset from
 * object storage. Only an exact path recorded at install time can be served, so path
 * traversal is impossible even before the safe-path grammar is applied. The endpoint is
 * authenticated (bearer JWT); the content is not user content and contains no secrets.
 */
@Service
public class GetPluginAssetService {

    private final PluginPackageRepository packages;
    private final PluginPackageObjectRepository objects;
    private final PluginAssetStoragePort storage;

    public GetPluginAssetService(PluginPackageRepository packages,
                                  PluginPackageObjectRepository objects,
                                  PluginAssetStoragePort storage) {
        this.packages = packages;
        this.objects = objects;
        this.storage = storage;
    }

    @Transactional(readOnly = true)
    public PluginAssetView get(String pluginId, String rawPath) {
        if (pluginId == null || !pluginId.matches("[a-z][a-z0-9-]{0,63}")) {
            throw missing();
        }
        packages.findByPluginId(pluginId).orElseThrow(GetPluginAssetService::missing);

        String path;
        try {
            path = PluginPaths.normalizeRequestPath(rawPath);
        } catch (IllegalArgumentException ex) {
            throw missing();
        }
        PluginPackageObject object = objects.find(pluginId, path).orElseThrow(() -> missing());
        byte[] content;
        try {
            content = storage.read(object.objectKey(), PluginAsset.MAX_ASSET_BYTES);
        } catch (RuntimeException ex) {
            if (ex instanceof DomainException) {
                throw ex;
            }
            throw DomainException.internal();
        }
        if (content.length != object.sizeBytes()
                || !PluginAsset.sha256(content).equals(object.sha256())) {
            throw DomainException.internal();
        }
        return new PluginAssetView(object.contentType(), content, object.sha256());
    }

    private static DomainException missing() {
        return DomainException.notFound(ErrorCode.NOT_FOUND, "Plugin asset not found",
                Map.of());
    }
}
