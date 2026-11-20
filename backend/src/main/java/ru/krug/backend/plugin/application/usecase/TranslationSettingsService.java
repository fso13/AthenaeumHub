package ru.krug.backend.plugin.application.usecase;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.plugin.application.model.EffectiveTranslationSettings;
import ru.krug.backend.plugin.application.model.TranslationSettingsView;
import ru.krug.backend.plugin.application.port.TranslationEnvPort;
import ru.krug.backend.plugin.application.service.TranslationProviderUrl;
import ru.krug.backend.plugin.domain.model.TranslationSettings;
import ru.krug.backend.plugin.domain.repository.TranslationSettingsRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code GET/PATCH /admin/plugins/translate} (#84) and the runtime reader used by the
 * translate plugin action.
 *
 * <p>An explicit administrator row wins. While no row exists the historical
 * {@code KRUG_PLUGINS_TRANSLATE_URL} environment value is the fallback, so existing
 * installations keep working. A saved row with {@code enabled=false} disables the provider
 * even when the environment variable is set. Only {@code enabled} and an https URL are
 * stored; there is no secret/API-key field. The audit trail contains the switch, a
 * {@code url_changed} flag and timestamps — never the URL itself.</p>
 */
@Service
public class TranslationSettingsService {

    static final String ACTION_UPDATED = "admin.plugin.translate.updated";
    private static final String TARGET = "translation_provider";

    private final PlatformAdminGuard adminGuard;
    private final TranslationSettingsRepository repository;
    private final TranslationEnvPort environment;
    private final AuditPort audit;
    private final ClockPort clock;

    public TranslationSettingsService(PlatformAdminGuard adminGuard,
                                      TranslationSettingsRepository repository,
                                      TranslationEnvPort environment, AuditPort audit,
                                      ClockPort clock) {
        this.adminGuard = adminGuard;
        this.repository = repository;
        this.environment = environment;
        this.audit = audit;
        this.clock = clock;
    }

    /**
     * Runtime value used by the translate provider on every call. No admin guard: this is
     * an installation setting, not tenant data.
     */
    @Transactional(readOnly = true)
    public EffectiveTranslationSettings current() {
        Optional<TranslationSettings> stored = repository.find();
        return stored.map(this::effective).orElseGet(this::environmentFallback);
    }

    @Transactional
    public TranslationSettingsView get(Principal principal) {
        adminGuard.require(principal);
        EffectiveTranslationSettings current = current();
        return new TranslationSettingsView(current.enabled(), current.url());
    }

    @Transactional
    public TranslationSettingsView update(Principal principal, Boolean enabled, String url) {
        adminGuard.require(principal);
        if (enabled == null && url == null) {
            throw DomainException.badRequest("At least one field is required",
                    Map.of("fields", java.util.List.of("enabled", "url")));
        }
        Optional<TranslationSettings> stored = repository.findForUpdate();
        TranslationSettings existing = stored.orElse(TranslationSettings.disabled());
        boolean nextEnabled = enabled == null ? existing.enabled() : enabled;
        String nextUrl = url == null ? existing.url() : TranslationProviderUrl.normalize(url);
        TranslationSettings next = new TranslationSettings(nextEnabled, nextUrl);

        EffectiveTranslationSettings effective = effective(next);
        if (nextEnabled && effective.url().isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.TRANSLATION_URL_REQUIRED,
                    "Translation provider URL is required when the provider is enabled",
                    Map.of("field", "url"));
        }

        boolean urlChanged = !Objects.equals(existing.url(), next.url());
        boolean enabledChanged = existing.enabled() != nextEnabled;
        if (stored.isEmpty() || enabledChanged || urlChanged) {
            repository.save(next, principal.userId(), clock.now());
            audit.append(new AuditRecord(null, principal.userId(), ACTION_UPDATED, TARGET, null,
                    principal.requestId(),
                    Map.of("enabled", effective.enabled(), "url_changed", urlChanged),
                    clock.now()));
        }
        return new TranslationSettingsView(effective.enabled(), effective.url());
    }

    private EffectiveTranslationSettings effective(TranslationSettings stored) {
        if (!stored.enabled()) {
            return EffectiveTranslationSettings.disabled();
        }
        if (stored.hasUrl()) {
            return new EffectiveTranslationSettings(true, stored.url());
        }
        EffectiveTranslationSettings fallback = environmentFallback();
        return fallback.enabled() ? fallback : EffectiveTranslationSettings.disabled();
    }

    private EffectiveTranslationSettings environmentFallback() {
        String value = environment.fallbackUrl();
        if (value == null || value.isBlank()) {
            return EffectiveTranslationSettings.disabled();
        }
        return new EffectiveTranslationSettings(true, value.strip());
    }
}
