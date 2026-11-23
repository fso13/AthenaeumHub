package ru.krug.backend.plugin.application.model;

import ru.krug.backend.plugin.domain.model.TranslationProviderKind;

/** Administrator-facing translation-provider settings. */
public record TranslationSettingsView(boolean enabled, String url,
                                      TranslationProviderKind provider) {

    public TranslationSettingsView {
        provider = provider == null ? TranslationProviderKind.AUTO : provider;
    }

    public TranslationSettingsView(boolean enabled, String url) {
        this(enabled, url, TranslationProviderKind.AUTO);
    }

    /**
     * Wire value for the admin API. Keeping the mapping here means the {@code api} package
     * does not depend on the domain enum (ArchUnit rule).
     */
    public String providerWire() {
        // `name()` is java.lang.Enum, so the api mapper (which calls this) does not depend
        // on a domain-defined method (ArchUnit rule apiDependsOnlyOnApplicationAndShared).
        return provider.name();
    }
}
