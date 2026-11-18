package ru.krug.backend.ops.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.SetupStatusView;
import ru.krug.backend.ops.application.port.SystemSettingsPort;

/**
 * {@code GET /setup/status}: public and secret-free. {@code registration_open} is the
 * persisted installation switch; the environment may still disable registration in the
 * auth BFF (an AND, documented in the README).
 */
@Service
public class GetSetupStatusService {

    private final SystemSettingsPort settings;

    public GetSetupStatusService(SystemSettingsPort settings) {
        this.settings = settings;
    }

    @Transactional(readOnly = true)
    public SetupStatusView status() {
        var current = settings.current();
        return new SetupStatusView(current.setupRequired(), current.registrationOpen());
    }
}
