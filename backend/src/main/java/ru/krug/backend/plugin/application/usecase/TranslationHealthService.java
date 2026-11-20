package ru.krug.backend.plugin.application.usecase;

import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.plugin.application.model.EffectiveTranslationSettings;
import ru.krug.backend.plugin.application.model.TranslationHealthView;
import ru.krug.backend.plugin.application.port.TranslationProbePort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code POST /admin/plugins/translate/test} (#84): one bounded provider probe.
 *
 * <p>The probe sends a constant text, discards the provider answer and never logs it. The
 * response carries only {@code status} and {@code latency_ms}; no source/translated text,
 * URL, header or provider body can appear. Auditing stores the same two values.</p>
 */
@Service
public class TranslationHealthService {

    static final String ACTION_TESTED = "admin.plugin.translate.tested";
    private static final String TARGET = "translation_provider";
    private static final long MAX_LATENCY_MS = 60_000L;

    private final PlatformAdminGuard adminGuard;
    private final TranslationSettingsService settings;
    private final TranslationProbePort probe;
    private final AuditPort audit;
    private final ClockPort clock;

    public TranslationHealthService(PlatformAdminGuard adminGuard,
                                    TranslationSettingsService settings,
                                    TranslationProbePort probe, AuditPort audit,
                                    ClockPort clock) {
        this.adminGuard = adminGuard;
        this.settings = settings;
        this.probe = probe;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public TranslationHealthView health(Principal principal) {
        adminGuard.require(principal);
        EffectiveTranslationSettings current = settings.current();
        if (!current.usable()) {
            return record(principal, TranslationHealthView.disabled());
        }
        long startedAt = System.nanoTime();
        String status;
        try {
            probe.probe();
            status = TranslationHealthView.OK;
        } catch (RuntimeException ex) {
            // Provider failures are content-free by contract; never surface the message.
            status = TranslationHealthView.UNAVAILABLE;
        }
        long latency = Math.max(0L, Math.min(MAX_LATENCY_MS,
                (System.nanoTime() - startedAt) / 1_000_000L));
        return record(principal, new TranslationHealthView(status, latency));
    }

    private TranslationHealthView record(Principal principal, TranslationHealthView view) {
        audit.append(new AuditRecord(null, principal.userId(), ACTION_TESTED, TARGET, null,
                principal.requestId(),
                Map.of("status", view.status(), "latency_ms", view.latencyMs()),
                clock.now()));
        return view;
    }
}
