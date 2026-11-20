package ru.krug.backend.plugin.api;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.plugin.api.dto.ChatPluginStateListResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginStateResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginUpdateRequest;
import ru.krug.backend.plugin.api.dto.PluginListResponse;
import ru.krug.backend.plugin.api.mapper.PluginApiMapper;
import ru.krug.backend.plugin.application.model.PluginAssetView;
import ru.krug.backend.plugin.application.usecase.GetPluginAssetService;
import ru.krug.backend.plugin.application.usecase.ListChatPluginsService;
import ru.krug.backend.plugin.application.usecase.ListPluginsService;
import ru.krug.backend.plugin.application.usecase.UpdateChatPluginService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * D1.1/D1.2 plugin catalog, per-chat toggles and static external package assets. No
 * plugin code is executed, no marketplace server call is made and no capability token is
 * issued. External assets are authenticated static files served from object storage.
 */
@RestController
@RequestMapping("/api/v1")
public class PluginController {

    private static final String CSP = "default-src 'none'; script-src 'unsafe-inline'; "
            + "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; "
            + "media-src data: blob:; connect-src 'none'; base-uri 'none'; "
            + "form-action 'none'; frame-ancestors 'self'";

    private final ListPluginsService listCatalog;
    private final ListChatPluginsService listChatPlugins;
    private final UpdateChatPluginService updateChatPlugin;
    private final GetPluginAssetService getPluginAsset;

    public PluginController(ListPluginsService listCatalog,
                            ListChatPluginsService listChatPlugins,
                            UpdateChatPluginService updateChatPlugin,
                            GetPluginAssetService getPluginAsset) {
        this.listCatalog = listCatalog;
        this.listChatPlugins = listChatPlugins;
        this.updateChatPlugin = updateChatPlugin;
        this.getPluginAsset = getPluginAsset;
    }

    @GetMapping("/plugins")
    public PluginListResponse listPlugins() {
        return PluginApiMapper.toResponse(listCatalog.list());
    }

    @GetMapping("/chats/{chatId}/plugins")
    public ChatPluginStateListResponse listChatPlugins(@PathVariable UUID chatId,
                                                       Principal principal) {
        return PluginApiMapper.toStateResponse(listChatPlugins.list(principal, chatId));
    }

    @PatchMapping("/chats/{chatId}/plugins/{pluginId}")
    public ChatPluginStateResponse updateChatPlugin(@PathVariable UUID chatId,
                                                    @PathVariable String pluginId,
                                                    @Valid @RequestBody
                                                    ChatPluginUpdateRequest request,
                                                    Principal principal) {
        return PluginApiMapper.toResponse(updateChatPlugin.update(principal, chatId, pluginId,
                request.enabled()));
    }

    /**
     * Static asset of an installed external package. The response is authenticated and
     * served with a restrictive CSP; the host MUST additionally render it in an iframe
     * with {@code sandbox="allow-scripts"} (no {@code allow-same-origin}).
     */
    @GetMapping("/plugins/{pluginId}/assets/{*path}")
    public ResponseEntity<byte[]> pluginAsset(@PathVariable String pluginId,
                                              @PathVariable("path") String path) {
        PluginAssetView asset = getPluginAsset.get(pluginId, path);
        MediaType mediaType = MediaType.parseMediaType(asset.contentType());
        String filename = path.substring(path.lastIndexOf('/') + 1);
        ContentDisposition disposition = (asset.inline()
                ? ContentDisposition.inline()
                : ContentDisposition.attachment())
                .filename(filename, StandardCharsets.UTF_8)
                .build();
        String csp = asset.contentType().startsWith("text/html")
                ? CSP + "; sandbox allow-scripts"
                : CSP;
        return ResponseEntity.ok()
                .contentType(mediaType)
                .contentLength(asset.size())
                .header(HttpHeaders.CACHE_CONTROL, "private, max-age=60")
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", csp)
                .header("Referrer-Policy", "no-referrer")
                .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
                .header("Cross-Origin-Resource-Policy", "same-origin")
                .body(asset.content());
    }
}
