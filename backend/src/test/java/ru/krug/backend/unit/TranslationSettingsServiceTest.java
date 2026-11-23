package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.plugin.application.model.EffectiveTranslationSettings;
import ru.krug.backend.plugin.application.port.TranslationEnvPort;
import ru.krug.backend.plugin.application.usecase.TranslationSettingsService;
import ru.krug.backend.plugin.domain.model.TranslationProviderKind;
import ru.krug.backend.plugin.domain.model.TranslationSettings;
import ru.krug.backend.plugin.domain.repository.TranslationSettingsRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/** Runtime settings resolution: explicit row > environment fallback, disable wins, provider. */
class TranslationSettingsServiceTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-20T10:00:00Z");
    private static final String ENV_URL = "https://env.example.test/v1";
    private static final String PROVIDER_URL = "https://provider.example.test/v1";

    private final PlatformAdminGuard guard = mock(PlatformAdminGuard.class);
    private final TranslationSettingsRepository repository =
            mock(TranslationSettingsRepository.class);
    private final TranslationEnvPort environment = mock(TranslationEnvPort.class);
    private final AuditPort audit = mock(AuditPort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private TranslationSettingsService service;
    private Principal principal;

    @BeforeEach
    void setUp() {
        service = new TranslationSettingsService(guard, repository, environment, audit, clock);
        principal = new Principal(USER_ID, null, null, "request");
        when(clock.now()).thenReturn(NOW);
        when(environment.fallbackUrl()).thenReturn("");
        when(environment.fallbackProvider()).thenReturn("");
    }

    @Test
    void currentUsesStoredRowWhenPresent() {
        when(repository.find()).thenReturn(Optional.of(
                new TranslationSettings(true, "https://stored.example.test/v1")));
        assertThat(service.current())
                .isEqualTo(new EffectiveTranslationSettings(true,
                        "https://stored.example.test/v1"));
    }

    @Test
    void currentCarriesTheStoredProvider() {
        when(repository.find()).thenReturn(Optional.of(new TranslationSettings(true,
                "http://libretranslate:5000/translate",
                TranslationProviderKind.LIBRETRANSLATE)));

        assertThat(service.current().provider())
                .isEqualTo(TranslationProviderKind.LIBRETRANSLATE);
    }

    @Test
    void currentUsesEnvironmentWhenNoRowExists() {
        when(repository.find()).thenReturn(Optional.empty());
        when(environment.fallbackUrl()).thenReturn(ENV_URL);
        assertThat(service.current())
                .isEqualTo(new EffectiveTranslationSettings(true, ENV_URL));
    }

    @Test
    void currentCarriesTheEnvironmentProvider() {
        when(repository.find()).thenReturn(Optional.empty());
        when(environment.fallbackUrl()).thenReturn(ENV_URL);
        when(environment.fallbackProvider()).thenReturn("libretranslate");

        assertThat(service.current().provider())
                .isEqualTo(TranslationProviderKind.LIBRETRANSLATE);
    }

    @Test
    void unknownEnvironmentProviderFallsBackToAuto() {
        when(repository.find()).thenReturn(Optional.empty());
        when(environment.fallbackUrl()).thenReturn(ENV_URL);
        when(environment.fallbackProvider()).thenReturn("libra");

        assertThat(service.current().provider()).isEqualTo(TranslationProviderKind.AUTO);
    }

    @Test
    void currentIsDisabledWithoutRowAndEnvironment() {
        when(repository.find()).thenReturn(Optional.empty());
        assertThat(service.current()).isEqualTo(EffectiveTranslationSettings.disabled());
    }

    @Test
    void explicitDisableWinsOverEnvironment() {
        when(repository.find()).thenReturn(Optional.of(new TranslationSettings(false, "")));
        when(environment.fallbackUrl()).thenReturn(ENV_URL);
        assertThat(service.current()).isEqualTo(EffectiveTranslationSettings.disabled());
    }

    @Test
    void enabledStoredRowWithoutUrlFallsBackToEnvironment() {
        when(repository.find()).thenReturn(Optional.of(new TranslationSettings(true, "")));
        when(environment.fallbackUrl()).thenReturn(ENV_URL);
        assertThat(service.current())
                .isEqualTo(new EffectiveTranslationSettings(true, ENV_URL));
    }

    @Test
    void enabledStoredRowWithoutUrlKeepsAnExplicitProvider() {
        when(repository.find()).thenReturn(Optional.of(new TranslationSettings(true, "",
                TranslationProviderKind.CUSTOM)));
        when(environment.fallbackUrl()).thenReturn(ENV_URL);
        when(environment.fallbackProvider()).thenReturn("libretranslate");

        assertThat(service.current())
                .isEqualTo(new EffectiveTranslationSettings(true, ENV_URL,
                        TranslationProviderKind.CUSTOM));
    }

    @Test
    void updateRequiresUrlWhenEnablingWithoutAnyFallback() {
        when(repository.findForUpdate()).thenReturn(Optional.empty());
        assertThat(catchDomain(() -> service.update(principal, true, null, null)).code())
                .isEqualTo(ErrorCode.TRANSLATION_URL_REQUIRED);
        verify(repository, never()).save(any(), any(), any());
        verify(audit, never()).append(any());
    }

    @Test
    void updateStoresAndAuditsValidSettingsWithoutTheUrl() {
        when(repository.findForUpdate()).thenReturn(Optional.empty());
        var view = service.update(principal, true, PROVIDER_URL, null);

        assertThat(view.enabled()).isTrue();
        assertThat(view.url()).isEqualTo(PROVIDER_URL);
        assertThat(view.provider()).isEqualTo(TranslationProviderKind.AUTO);
        verify(repository).save(new TranslationSettings(true, PROVIDER_URL), USER_ID, NOW);
        verify(audit).append(any());
    }

    @Test
    void updateStoresAndReturnsTheSelectedProvider() {
        when(repository.findForUpdate()).thenReturn(Optional.empty());
        var view = service.update(principal, true,
                "http://libretranslate:5000/translate", "libretranslate");

        assertThat(view.provider()).isEqualTo(TranslationProviderKind.LIBRETRANSLATE);
        verify(repository).save(new TranslationSettings(true,
                "http://libretranslate:5000/translate",
                TranslationProviderKind.LIBRETRANSLATE), USER_ID, NOW);
    }

    @Test
    void updateRejectsAnUnknownProvider() {
        when(repository.findForUpdate()).thenReturn(Optional.empty());
        assertThat(catchDomain(() -> service.update(principal, null, null, "libra")).code())
                .isEqualTo(ErrorCode.TRANSLATION_PROVIDER_INVALID);
        verify(repository, never()).save(any(), any(), any());
    }

    @Test
    void updateWithOnlyAProviderChangeIsAuditedOnce() {
        TranslationSettings existing = new TranslationSettings(true, PROVIDER_URL,
                TranslationProviderKind.AUTO);
        when(repository.findForUpdate()).thenReturn(Optional.of(existing));

        var view = service.update(principal, null, null, "custom");

        assertThat(view.provider()).isEqualTo(TranslationProviderKind.CUSTOM);
        verify(repository).save(new TranslationSettings(true, PROVIDER_URL,
                TranslationProviderKind.CUSTOM), USER_ID, NOW);
        verify(audit).append(any());
    }

    @Test
    void updateNoOpDoesNotCreateASecondAudit() {
        TranslationSettings existing = new TranslationSettings(true, PROVIDER_URL,
                TranslationProviderKind.CUSTOM);
        when(repository.findForUpdate()).thenReturn(Optional.of(existing));

        service.update(principal, true, PROVIDER_URL, "custom");

        verify(repository, never()).save(any(), any(), any());
        verify(audit, never()).append(any());
    }

    @Test
    void updateRejectsInvalidUrl() {
        when(repository.findForUpdate()).thenReturn(Optional.empty());
        assertThat(catchDomain(() -> service.update(principal, true,
                "http://provider.example.test", null)).code())
                .isEqualTo(ErrorCode.TRANSLATION_URL_INVALID);
    }

    private static DomainException catchDomain(Runnable task) {
        try {
            task.run();
        } catch (DomainException ex) {
            return ex;
        }
        throw new AssertionError("DomainException expected");
    }
}
