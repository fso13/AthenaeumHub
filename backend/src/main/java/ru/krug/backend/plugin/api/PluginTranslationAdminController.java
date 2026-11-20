package ru.krug.backend.plugin.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.plugin.api.dto.TranslationProviderSettingsResponse;
import ru.krug.backend.plugin.api.dto.TranslationProviderTestResponse;
import ru.krug.backend.plugin.api.dto.UpdateTranslationProviderRequest;
import ru.krug.backend.plugin.api.mapper.PluginTranslationApiMapper;
import ru.krug.backend.plugin.application.usecase.TranslationHealthService;
import ru.krug.backend.plugin.application.usecase.TranslationSettingsService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Platform-admin translation provider configuration (#84).
 *
 * <pre>
 * GET   /admin/plugins/translate       -> {enabled, url}
 * PATCH /admin/plugins/translate       -> {enabled, url} (https URL only, no secrets)
 * POST  /admin/plugins/translate/test  -> {status, latency_ms}
 * </pre>
 *
 * <p>The service enforces the platform-admin guard. The stored configuration has no
 * credential field, the URL is never logged, and the health probe never returns content.</p>
 */
@RestController
@RequestMapping("/api/v1/admin/plugins/translate")
public class PluginTranslationAdminController {

    private final TranslationSettingsService settings;
    private final TranslationHealthService health;

    public PluginTranslationAdminController(TranslationSettingsService settings,
                                            TranslationHealthService health) {
        this.settings = settings;
        this.health = health;
    }

    @GetMapping
    public TranslationProviderSettingsResponse get(Principal principal) {
        return PluginTranslationApiMapper.toResponse(settings.get(principal));
    }

    @PatchMapping
    public TranslationProviderSettingsResponse update(
            @RequestBody UpdateTranslationProviderRequest request, Principal principal) {
        return PluginTranslationApiMapper.toResponse(
                settings.update(principal, request.enabled(), request.url()));
    }

    @PostMapping("/test")
    public TranslationProviderTestResponse test(Principal principal) {
        return PluginTranslationApiMapper.toResponse(health.health(principal));
    }
}
