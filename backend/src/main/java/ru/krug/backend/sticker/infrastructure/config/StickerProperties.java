package ru.krug.backend.sticker.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** E5-B sticker configuration. */
@ConfigurationProperties(prefix = "krug.stickers")
public class StickerProperties {

    /**
     * Prefix for stored asset paths (for example {@code https://cdn.example/stickers}).
     * Empty means the stored relative path is returned as-is; the web client serves
     * {@code /stickers/**} from its public assets.
     */
    private String assetBaseUrl = "";

    public String getAssetBaseUrl() {
        return assetBaseUrl;
    }

    public void setAssetBaseUrl(String assetBaseUrl) {
        this.assetBaseUrl = assetBaseUrl == null ? "" : assetBaseUrl;
    }
}
