package ru.krug.backend.ops.infrastructure.scheduling;

import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.port.SystemSettingsPort;

/**
 * Safety net for clustered deployments: the settings PATCH evicts the local cache
 * immediately, but a node that did not handle the PATCH would otherwise keep its copy
 * forever. A short periodic clear bounds that staleness to 30 seconds without a restart.
 * In a single-node deployment the PATCH eviction already makes the change immediate.
 */
@Component
public class SystemSettingsCacheRefresher {

    private static final long REFRESH_INTERVAL_MS = 30_000L;

    private final CacheManager cacheManager;

    public SystemSettingsCacheRefresher(CacheManager cacheManager) {
        this.cacheManager = cacheManager;
    }

    @Scheduled(fixedDelay = REFRESH_INTERVAL_MS)
    public void evictAllowedFileExtensions() {
        Cache cache = cacheManager.getCache(
                SystemSettingsPort.ALLOWED_FILE_EXTENSIONS_CACHE);
        if (cache != null) {
            cache.clear();
        }
    }
}
