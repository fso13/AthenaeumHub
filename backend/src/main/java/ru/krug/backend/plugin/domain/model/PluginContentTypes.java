package ru.krug.backend.plugin.domain.model;

import java.util.Map;

/**
 * Closed content-type map for static plugin assets. Unknown extensions are served as
 * {@code application/octet-stream} with an attachment disposition; nothing is ever
 * executed by the backend.
 */
public final class PluginContentTypes {

    public static final String DEFAULT = "application/octet-stream";

    private static final Map<String, String> BY_EXTENSION = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("htm", "text/html; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("mjs", "text/javascript; charset=utf-8"),
            Map.entry("json", "application/json; charset=utf-8"),
            Map.entry("map", "application/json; charset=utf-8"),
            Map.entry("txt", "text/plain; charset=utf-8"),
            Map.entry("md", "text/markdown; charset=utf-8"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("jpg", "image/jpeg"),
            Map.entry("jpeg", "image/jpeg"),
            Map.entry("gif", "image/gif"),
            Map.entry("webp", "image/webp"),
            Map.entry("avif", "image/avif"),
            Map.entry("ico", "image/x-icon"),
            Map.entry("woff", "font/woff"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("ttf", "font/ttf"),
            Map.entry("otf", "font/otf"),
            Map.entry("mp3", "audio/mpeg"),
            Map.entry("mp4", "video/mp4"),
            Map.entry("webm", "video/webm"));

    private PluginContentTypes() {
    }

    public static String forPath(String path) {
        return BY_EXTENSION.getOrDefault(PluginPaths.extension(path), DEFAULT);
    }

    /** Inline assets are safe to render; everything else is downloaded as an attachment. */
    public static boolean inline(String contentType) {
        if (contentType == null) {
            return false;
        }
        return contentType.startsWith("text/")
                || contentType.startsWith("image/")
                || contentType.startsWith("font/")
                || contentType.startsWith("audio/")
                || contentType.startsWith("video/")
                || contentType.startsWith("application/json");
    }
}
