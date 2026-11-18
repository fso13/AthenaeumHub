package ru.krug.backend.sticker.infrastructure.adapter;

import org.springframework.stereotype.Component;

import ru.krug.backend.sticker.application.port.StickerAssetUrlResolver;
import ru.krug.backend.sticker.infrastructure.config.StickerProperties;

/** Expands stored paths with the configured asset base URL (CDN in a real deployment). */
@Component
public class ConfiguredStickerAssetUrlResolver implements StickerAssetUrlResolver {

    private final String baseUrl;

    public ConfiguredStickerAssetUrlResolver(StickerProperties properties) {
        String configured = properties.getAssetBaseUrl() == null
                ? "" : properties.getAssetBaseUrl().strip();
        this.baseUrl = configured.endsWith("/")
                ? configured.substring(0, configured.length() - 1) : configured;
    }

    @Override
    public String resolve(String storedUrl) {
        if (storedUrl == null || storedUrl.isBlank() || baseUrl.isEmpty()
                || storedUrl.startsWith("http://") || storedUrl.startsWith("https://")) {
            return storedUrl;
        }
        return baseUrl + (storedUrl.startsWith("/") ? storedUrl : "/" + storedUrl);
    }
}
