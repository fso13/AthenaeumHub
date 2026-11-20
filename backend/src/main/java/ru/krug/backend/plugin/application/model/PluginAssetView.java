package ru.krug.backend.plugin.application.model;

import java.util.Objects;

import ru.krug.backend.plugin.domain.model.PluginContentTypes;

/** Bytes and safe transport metadata for one static asset response. */
public record PluginAssetView(String contentType, byte[] content, String sha256) {

    public PluginAssetView {
        Objects.requireNonNull(contentType, "contentType");
        Objects.requireNonNull(content, "content");
        if (contentType.isBlank() || contentType.length() > 128) {
            throw new IllegalArgumentException("content type is invalid");
        }
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("asset digest is invalid");
        }
        content = content.clone();
    }

    @Override
    public byte[] content() {
        return content.clone();
    }

    public int size() {
        return content.length;
    }

    public boolean inline() {
        return PluginContentTypes.inline(contentType);
    }
}
